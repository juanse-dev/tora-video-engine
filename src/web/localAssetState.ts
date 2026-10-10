import {
  collectStoryLocalAssetUsages,
  describeBudgetFailure,
  evaluateLocalAssetBudget,
  type LocalAssetBudgetResult,
  type LocalAssetUsage,
  type PayloadMetadata,
} from "../localAssets/readiness.ts";
import type {LocalAssetRef} from "../localAssets/refs.ts";
import type {LocalAssetSourceMap} from "../localAssets/sources.ts";
import type {Story} from "../story/schema.ts";
import {withAssetLibraryLock, type AssetLibraryStatus} from "./assetLibrary/coordination.ts";
import {
  verifyPayloadsSequentially,
  type IntegrityCache,
  type VerifiedPayload,
} from "./assetLibrary/integrity.ts";
import type {AssetLibraryStore} from "./assetLibrary/store.ts";

export type LocalAssetRefState = {
  usage: LocalAssetUsage;
  status: "ready" | "missing" | "corrupt" | "unavailable";
  detail: string | null; // diagnostic text, e.g. "hash mismatch"
};

export type StoryLocalAssetState =
  | {kind: "none"} // Story has no local refs
  | {kind: "pending"; usages: LocalAssetUsage[]}
  | {
      kind: "over-budget";
      usages: LocalAssetUsage[];
      budget: Extract<LocalAssetBudgetResult, {ok: false}>;
      message: string;
    }
  | {
      kind: "resolved";
      refs: LocalAssetRefState[];
      verified: ReadonlyMap<string, VerifiedPayload>; // digest -> payload, only for ready digests
      blobs: ReadonlyMap<string, Blob>; // digest -> blob, only for ready digests
      allReady: boolean;
      failureMessage: string | null; // set only by resolveStoryLocalAssetsForPreview when reading failed
    };

export type ResolvedStoryLocalAssetState = Extract<
  StoryLocalAssetState,
  {kind: "resolved"}
>;

export type SettledStoryLocalAssetState = Exclude<
  StoryLocalAssetState,
  {kind: "pending"}
>;

export type LocalAssetRenderPreparation =
  | {
      ok: true;
      localAssetSources: LocalAssetSourceMap | undefined;
      release: () => void;
    }
  | {ok: false; message: string};

/**
 * The part of the ref-counted object URL pool this module needs. The real
 * `ObjectUrlPool` (src/web/objectUrlPool.ts) satisfies it structurally.
 */
export type LocalAssetUrlPool = {
  acquire(digest: string, blob: Blob): string;
  release(digest: string): void;
};

export const LOCAL_ASSETS_PENDING_MESSAGE = "Checking local assets…";
export const LOCAL_ASSETS_CHANGED_MESSAGE =
  "Local assets changed while preparing the render. Try again.";
const LOCAL_ASSETS_NOT_READY_MESSAGE =
  "Local assets are not ready. Try again.";

export const unavailableState = (
  usages: readonly LocalAssetUsage[],
  detail: string,
  failureMessage: string | null,
): ResolvedStoryLocalAssetState => ({
  kind: "resolved",
  refs: usages.map((usage) => ({usage, status: "unavailable", detail})),
  verified: new Map(),
  blobs: new Map(),
  allReady: false,
  failureMessage,
});

export const resolveStoryLocalAssets = async (
  story: Story,
  library: AssetLibraryStatus,
  cache: IntegrityCache,
  deps: {subtle?: SubtleCrypto; signal?: AbortSignal} = {},
): Promise<SettledStoryLocalAssetState> => {
  const {signal} = deps;

  signal?.throwIfAborted();

  // 1. Stories without local refs never touch storage.
  const usages = collectStoryLocalAssetUsages(story);

  if (usages.length === 0) {
    return {kind: "none"};
  }

  // 2. The ref cap is checked first and independent of storage.
  const refBudget = evaluateLocalAssetBudget(usages, new Map());

  if (!refBudget.ok) {
    return {
      kind: "over-budget",
      usages,
      budget: refBudget,
      message: describeBudgetFailure(refBudget),
    };
  }

  if (library.kind !== "ready") {
    return unavailableState(usages, library.message, null);
  }

  const store = library.store;
  const statusByRef = new Map<
    LocalAssetRef,
    {status: LocalAssetRefState["status"]; detail: string | null}
  >();

  // 3. The ref itself is the key (INV-11); the stored row never redirects it.
  signal?.throwIfAborted();

  const candidatesByDigest = new Map<string, LocalAssetUsage[]>();

  for (const usage of usages) {
    const rowRecord = await store.getAssetRow(usage.ref);

    if (rowRecord.status === "absent") {
      statusByRef.set(usage.ref, {
        status: "missing",
        detail: "asset is not in My assets",
      });
    } else if (rowRecord.status === "corrupt") {
      statusByRef.set(usage.ref, {
        status: "corrupt",
        detail: `asset record is corrupt: ${rowRecord.reason}`,
      });
    } else {
      const candidates = candidatesByDigest.get(usage.digest) ?? [];

      candidates.push(usage);
      candidatesByDigest.set(usage.digest, candidates);
    }
  }

  // 4. Metadata per distinct digest that still has a candidate ref.
  signal?.throwIfAborted();

  const metadataByDigest = new Map<string, PayloadMetadata>();

  for (const [digest, candidates] of candidatesByDigest) {
    const metaRecord = await store.getPayloadMeta(digest);

    if (metaRecord.status === "present") {
      metadataByDigest.set(digest, metaRecord.value);
      continue;
    }

    const failure: {status: "missing" | "corrupt"; detail: string} =
      metaRecord.status === "absent"
        ? {status: "missing", detail: "payload metadata is missing"}
        : {
            status: "corrupt",
            detail: `payload metadata is corrupt: ${metaRecord.reason}`,
          };

    for (const usage of candidates) {
      statusByRef.set(usage.ref, failure);
    }
  }

  // 5. D-10: over-budget is decided from metadata alone, before any blob read.
  const budget = evaluateLocalAssetBudget(usages, metadataByDigest);

  if (!budget.ok) {
    return {
      kind: "over-budget",
      usages,
      budget,
      message: describeBudgetFailure(budget),
    };
  }

  // 6. Sequential verification; one failed digest does not stop the others.
  signal?.throwIfAborted();

  const verification = await verifyPayloadsSequentially(
    store,
    [...metadataByDigest.keys()],
    cache,
    {subtle: deps.subtle, signal},
  );
  const verified = new Map<string, VerifiedPayload>();
  const blobs = new Map<string, Blob>();

  for (const [digest, result] of verification) {
    if (result.ok) {
      verified.set(digest, result.payload);
      blobs.set(digest, result.blob);
      continue;
    }

    for (const usage of candidatesByDigest.get(digest) ?? []) {
      statusByRef.set(usage.ref, {status: result.reason, detail: result.detail});
    }
  }

  // 7.
  const refs: LocalAssetRefState[] = usages.map((usage) => {
    const failure = statusByRef.get(usage.ref);

    return failure === undefined
      ? {usage, status: "ready", detail: null}
      : {usage, status: failure.status, detail: failure.detail};
  });

  return {
    kind: "resolved",
    refs,
    verified,
    blobs,
    allReady: refs.every((entry) => entry.status === "ready"),
    failureMessage: null,
  };
};

const isAbort = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true ||
  (typeof error === "object" &&
    error !== null &&
    (error as {name?: unknown}).name === "AbortError");

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message !== ""
    ? error.message
    : typeof error === "string" && error !== ""
      ? error
      : "Local assets could not be read from this browser. Reload the page and try again.";

/**
 * Preview wrapper: any non-abort failure (a connection closed by
 * `versionchange`, a read error...) becomes a `resolved` state, so the Preview
 * never ends up with an unhandled rejection. Abort still rejects.
 */
export const resolveStoryLocalAssetsForPreview = async (
  ...args: Parameters<typeof resolveStoryLocalAssets>
): Promise<SettledStoryLocalAssetState> => {
  try {
    return await resolveStoryLocalAssets(...args);
  } catch (error) {
    if (isAbort(error, args[3]?.signal)) {
      throw error;
    }

    const message = errorMessage(error);

    return unavailableState(
      collectStoryLocalAssetUsages(args[0]),
      message,
      message,
    );
  }
};

const samePayload = (verified: VerifiedPayload, current: PayloadMetadata) =>
  verified.mimeType === current.mimeType &&
  verified.byteSize === current.byteSize &&
  verified.width === current.width &&
  verified.height === current.height;

/**
 * Builds the post-lock step for startBrowserRenderTransaction. Under the shared
 * asset lock it re-checks every row and payload against what was verified
 * (rows per ref, not per digest), then leases blob URLs for the render.
 */
export const createLocalAssetRenderPreparation =
  (input: {
    resolved: ResolvedStoryLocalAssetState; // must have allReady
    store: AssetLibraryStore;
    locks: LockManager;
    pool: LocalAssetUrlPool;
  }) =>
  async (signal: AbortSignal): Promise<LocalAssetRenderPreparation> => {
    const {resolved, store, locks, pool} = input;

    if (!resolved.allReady) {
      return {ok: false, message: LOCAL_ASSETS_NOT_READY_MESSAGE};
    }

    return withAssetLibraryLock(
      locks,
      "shared",
      async (): Promise<LocalAssetRenderPreparation> => {
        const changed: LocalAssetRenderPreparation = {
          ok: false,
          message: LOCAL_ASSETS_CHANGED_MESSAGE,
        };
        const checkedDigests = new Set<string>();

        for (const {usage} of resolved.refs) {
          signal.throwIfAborted();

          const rowRecord = await store.getAssetRow(usage.ref);

          if (rowRecord.status !== "present") {
            return changed;
          }

          if (checkedDigests.has(usage.digest)) {
            continue;
          }

          checkedDigests.add(usage.digest);

          const verified = resolved.verified.get(usage.digest);
          const metaRecord = await store.getPayloadMeta(usage.digest);

          if (
            verified === undefined ||
            metaRecord.status !== "present" ||
            !samePayload(verified, metaRecord.value)
          ) {
            return changed;
          }
        }

        signal.throwIfAborted();

        const acquired: string[] = [];
        const urlByDigest = new Map<string, string>();

        try {
          for (const digest of checkedDigests) {
            const blob = resolved.blobs.get(digest);

            if (blob === undefined) {
              throw new Error("A verified local asset has no blob.");
            }

            urlByDigest.set(digest, pool.acquire(digest, blob));
            acquired.push(digest);
          }
        } catch (error) {
          for (const digest of acquired) {
            pool.release(digest);
          }

          throw error;
        }

        const sources: Partial<Record<LocalAssetRef, {kind: "url"; url: string}>> =
          {};

        for (const {usage} of resolved.refs) {
          sources[usage.ref] = {
            kind: "url",
            url: urlByDigest.get(usage.digest) as string,
          };
        }

        let released = false;

        return {
          ok: true,
          localAssetSources: Object.freeze(sources),
          release: () => {
            if (released) {
              return;
            }

            released = true;

            for (const digest of acquired) {
              pool.release(digest);
            }
          },
        };
      },
      {signal},
    );
  };

/** Message for the render button area, or null when local assets allow rendering. */
export const describeLocalAssetRenderBlock = (
  state: StoryLocalAssetState,
  library: AssetLibraryStatus,
): string | null => {
  if (state.kind === "resolved" && state.failureMessage !== null) {
    return state.failureMessage;
  }

  if (state.kind !== "none" && library.kind !== "ready") {
    return library.message;
  }

  switch (state.kind) {
    case "none":
      return null;
    case "pending":
      return LOCAL_ASSETS_PENDING_MESSAGE;
    case "over-budget":
      return state.message;
    case "resolved": {
      const unavailable = state.refs.filter(
        (entry) => entry.status !== "ready",
      ).length;

      return unavailable === 0
        ? null
        : `Browser render is blocked because ${unavailable} local asset(s) are unavailable in this browser.`;
    }
  }
};
