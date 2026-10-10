import {
  collectStoryLocalAssetUsages,
  type LocalAssetUsage,
} from "../localAssets/readiness.ts";
import type {LocalAssetRef} from "../localAssets/refs.ts";
import type {
  LocalAssetSource,
  LocalAssetSourceMap,
} from "../localAssets/sources.ts";
import type {Story} from "../story/schema.ts";
import type {AssetLibraryStatus} from "./assetLibrary/coordination.ts";
import type {IntegrityCache} from "./assetLibrary/integrity.ts";
import {
  resolveStoryLocalAssetsForPreview,
  unavailableState,
  type LocalAssetUrlPool,
  type SettledStoryLocalAssetState,
} from "./localAssetState.ts";

/** A set of pool digests held together. `release` is idempotent. */
export type LocalAssetLease = {release(): void};

export type StoryLocalAssetsSnapshot = {
  state: SettledStoryLocalAssetState;
  sources: LocalAssetSourceMap | undefined;
  lease: LocalAssetLease;
};

type ResolveForPreview = typeof resolveStoryLocalAssetsForPreview;

const emptyLease: LocalAssetLease = {release() {}};

/**
 * Sources while a generation runs: URLs of the previous generation are kept for
 * refs still in the Story, every other local ref is `pending`.
 */
export const buildPendingSources = (
  usages: readonly LocalAssetUsage[],
  previous: LocalAssetSourceMap | undefined,
): LocalAssetSourceMap | undefined => {
  if (usages.length === 0) {
    return undefined;
  }

  const sources: Partial<Record<LocalAssetRef, LocalAssetSource>> = {};

  for (const usage of usages) {
    const kept = previous?.[usage.ref];

    sources[usage.ref] = kept?.kind === "url" ? kept : {kind: "pending"};
  }

  return sources;
};

const isAbort = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as {name?: unknown}).name === "AbortError";

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message !== ""
    ? error.message
    : "Local assets could not be read from this browser. Reload the page and try again.";

/**
 * Framework-free core of `useStoryLocalAssets`. Each `start` is a generation:
 * it aborts the previous generation, and only the latest generation may settle
 * (and acquire pool URLs). The caller owns each snapshot's lease and releases
 * it once the next snapshot has been committed.
 */
export const createStoryLocalAssetsController = (deps: {
  pool: LocalAssetUrlPool;
  cache: IntegrityCache;
  resolve?: ResolveForPreview;
}) => {
  const resolve = deps.resolve ?? resolveStoryLocalAssetsForPreview;
  let current: AbortController | null = null;

  const leaseSources = (
    state: SettledStoryLocalAssetState,
  ): StoryLocalAssetsSnapshot => {
    if (state.kind !== "resolved") {
      return {
        state,
        sources: undefined,
        lease: emptyLease,
      };
    }

    const acquired: string[] = [];
    const urlByDigest = new Map<string, string>();

    try {
      for (const entry of state.refs) {
        const {digest} = entry.usage;
        const blob = state.blobs.get(digest);

        if (entry.status !== "ready" || blob === undefined) {
          continue;
        }

        if (!urlByDigest.has(digest)) {
          urlByDigest.set(digest, deps.pool.acquire(digest, blob));
          acquired.push(digest);
        }
      }
    } catch (error) {
      for (const digest of acquired) {
        deps.pool.release(digest);
      }

      throw error;
    }

    const sources: Partial<Record<LocalAssetRef, LocalAssetSource>> = {};

    for (const entry of state.refs) {
      const url =
        entry.status === "ready" ? urlByDigest.get(entry.usage.digest) : undefined;

      if (url !== undefined) {
        sources[entry.usage.ref] = {kind: "url", url};
      }
    }

    let released = false;

    return {
      state,
      sources,
      lease: {
        release() {
          if (released) {
            return;
          }

          released = true;

          for (const digest of acquired) {
            deps.pool.release(digest);
          }
        },
      },
    };
  };

  const settleFailure = (
    story: Story,
    error: unknown,
  ): StoryLocalAssetsSnapshot => {
    const message = messageOf(error);

    return {
      state: unavailableState(
        collectStoryLocalAssetUsages(story),
        message,
        message,
      ),
      sources: {},
      lease: emptyLease,
    };
  };

  const run = async (
    generation: AbortController,
    story: Story,
    library: AssetLibraryStatus,
    onSettled: (snapshot: StoryLocalAssetsSnapshot) => void,
  ) => {
    let snapshot: StoryLocalAssetsSnapshot;

    try {
      const state = await resolve(story, library, deps.cache, {
        signal: generation.signal,
      });

      // A superseded generation never acquires URLs or settles.
      if (current !== generation || generation.signal.aborted) {
        return;
      }

      try {
        snapshot = leaseSources(state);
      } catch (error) {
        snapshot = settleFailure(story, error);
      }
    } catch (error) {
      if (current !== generation || generation.signal.aborted || isAbort(error)) {
        return;
      }

      snapshot = settleFailure(story, error);
    }

    onSettled(snapshot);
  };

  return {
    /**
     * Starts a generation, aborting the previous one. `onSettled` is called at
     * most once, only if this is still the latest generation. Returns a cancel
     * function (used by effect cleanup).
     */
    start(
      story: Story,
      library: AssetLibraryStatus,
      onSettled: (snapshot: StoryLocalAssetsSnapshot) => void,
    ): () => void {
      current?.abort();

      const generation = new AbortController();

      current = generation;
      void run(generation, story, library, onSettled);

      return () => {
        generation.abort();

        if (current === generation) {
          current = null;
        }
      };
    },
  };
};
