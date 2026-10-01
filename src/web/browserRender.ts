import {
  canRenderMediaOnWeb,
  renderMediaOnWeb,
  type RenderMediaOnWebProgress,
  type RenderMediaOnWebResult,
} from "@remotion/web-renderer";
import type {ComponentType} from "react";
import type {Story} from "../story/types.ts";
import {
  VIDEO_FPS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
} from "../videoConfig.ts";
import {
  evaluateBrowserStoryPolicy,
  type BrowserStoryPolicyDependencies,
} from "./browserPolicy.ts";
import {storiesSemanticallyEqual} from "./persistence.ts";

export const WEB_RENDER_LOCK_NAME =
  "tora-video-engine:web-fs-render";
export const REMOTION_OPFS_PREFIX = "__remotion_render:";
export const OPFS_CLEANUP_BACKOFF_MS = [
  0,
  25,
  50,
  100,
  200,
  400,
  800,
  1_600,
  3_200,
] as const;

export type BrowserRenderCapability =
  | {
      kind: "ready";
    }
  | {
      kind: "unsupported";
      message: string;
    };

export type BrowserRenderLockLease =
  | {
      mode: "owner";
      release: () => void;
    }
  | {
      mode: "busy";
    }
  | {
      mode: "unavailable";
      message: string;
    };

export type OpfsCleanupResult =
  | {
      ok: true;
      attempts: number;
    }
  | {
      ok: false;
      attempts: number;
      error: Error | null;
      remaining: string[];
    };

export type BrowserRenderPendingOutcome =
  | {
      kind: "success";
      blob: Blob;
      consumed: boolean;
    }
  | {
      kind: "failure";
      error: Error;
    }
  | {
      kind: "cancelled";
    };

export type BrowserRenderCleanupBlocked = {
  kind: "cleanup-blocked";
  stage: "pre" | "post";
  lease: Extract<BrowserRenderLockLease, {mode: "owner"}>;
  pending: BrowserRenderPendingOutcome | null;
  cleanup: Extract<OpfsCleanupResult, {ok: false}>;
};

export type BrowserRenderTransactionOutcome =
  | BrowserRenderPendingOutcome
  | BrowserRenderCleanupBlocked
  | {
      kind: "busy";
    }
  | {
      kind: "unsupported";
      message: string;
    };

export type BrowserRenderCleanupRetryOutcome =
  | BrowserRenderCleanupBlocked
  | BrowserRenderPendingOutcome
  | {
      kind: "pre-cleanup-cleared";
    };

type OpfsRoot = {
  entries: () => AsyncIterable<[string, unknown]>;
  removeEntry: (name: string) => Promise<void>;
};

type CapabilityChecker = typeof canRenderMediaOnWeb;
type RenderFunction = typeof renderMediaOnWeb;

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export const materializeBrowserDownloadBlob = async (
  blob: Blob,
): Promise<Blob> =>
  new Blob([await blob.arrayBuffer()], {
    type: blob.type,
  });

const defaultWait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });

const defaultGetLocks = (): LockManager | undefined =>
  typeof navigator === "undefined" ? undefined : navigator.locks;

const defaultGetDirectory = async (): Promise<OpfsRoot> =>
  (await navigator.storage.getDirectory()) as unknown as OpfsRoot;

const listRemotionEntries = async (
  root: OpfsRoot,
): Promise<string[]> => {
  const entries: string[] = [];

  for await (const [name] of root.entries()) {
    if (name.startsWith(REMOTION_OPFS_PREFIX)) {
      entries.push(name);
    }
  }

  return entries;
};

export const checkBrowserRenderCapability = async (
  options: {
    canRender?: CapabilityChecker;
    getLocks?: () => LockManager | undefined;
  } = {},
): Promise<BrowserRenderCapability> => {
  const getLocks = options.getLocks ?? defaultGetLocks;

  if (getLocks() === undefined) {
    return {
      kind: "unsupported",
      message:
        "Browser MP4 export requires the Web Locks API for safe cross-tab rendering. Preview, YAML export, and the local CLI remain available.",
    };
  }

  const canRender = options.canRender ?? canRenderMediaOnWeb;
  let result: Awaited<ReturnType<CapabilityChecker>>;

  try {
    result = await canRender({
      container: "mp4",
      videoCodec: "h264",
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      muted: true,
    });
  } catch (error) {
    return {
      kind: "unsupported",
      message: `Browser render capability detection failed: ${asError(error).message}. Preview, YAML export, and the local CLI remain available.`,
    };
  }

  if (!result.canRender) {
    const messages = result.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message);

    return {
      kind: "unsupported",
      message:
        messages.length > 0
          ? `Browser MP4 export is unavailable: ${messages.join(" ")} YAML export and the local CLI remain available.`
          : "Browser MP4 export is unavailable in this browser. YAML export and the local CLI remain available.",
    };
  }

  if (result.resolvedOutputTarget !== "web-fs") {
    return {
      kind: "unsupported",
      message:
        "Browser MP4 export requires Remotion's web-fs output target. This browser only offers the in-memory fallback, so use YAML export and the local CLI instead.",
    };
  }

  return {kind: "ready"};
};

export const getBrowserRenderLockStatus = async (
  getLocks: () => LockManager | undefined = defaultGetLocks,
): Promise<"available" | "busy" | "unavailable"> => {
  const locks = getLocks();

  if (locks === undefined) {
    return "unavailable";
  }

  try {
    const snapshot = await locks.query();
    const relevant = [
      ...(snapshot.held ?? []),
      ...(snapshot.pending ?? []),
    ].some(
      (lock) => lock.name === WEB_RENDER_LOCK_NAME,
    );

    return relevant ? "busy" : "available";
  } catch {
    return "unavailable";
  }
};

export const acquireBrowserRenderLock = async (
  getLocks: () => LockManager | undefined = defaultGetLocks,
): Promise<BrowserRenderLockLease> => {
  const locks = getLocks();

  if (locks === undefined) {
    return {
      mode: "unavailable",
      message:
        "Browser MP4 export requires Web Locks for cross-tab safety.",
    };
  }

  let releaseHold: (() => void) | null = null;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });

  let resolveAcquired: ((owned: boolean) => void) | null = null;
  const acquired = new Promise<boolean>((resolve) => {
    resolveAcquired = resolve;
  });

  const requestState: {error: Error | null} = {error: null};

  void locks
    .request(
      WEB_RENDER_LOCK_NAME,
      {mode: "exclusive", ifAvailable: true},
      async (lock: Lock | null) => {
        resolveAcquired?.(lock !== null);

        if (lock !== null) {
          await hold;
        }
      },
    )
    .catch((error) => {
      requestState.error = asError(error);
      resolveAcquired?.(false);
    });

  const owned = await acquired;

  if (!owned) {
    if (requestState.error !== null) {
      return {
        mode: "unavailable",
        message: `Could not acquire the browser render lock: ${requestState.error.message}`,
      };
    }

    return {mode: "busy"};
  }

  return {
    mode: "owner",
    release: () => {
      releaseHold?.();
      releaseHold = null;
    },
  };
};

export const cleanupRemotionOpfsUntilEmpty = async (
  options: {
    getDirectory?: () => Promise<OpfsRoot>;
    wait?: (milliseconds: number) => Promise<void>;
    backoffMs?: readonly number[];
  } = {},
): Promise<OpfsCleanupResult> => {
  const getDirectory = options.getDirectory ?? defaultGetDirectory;
  const wait = options.wait ?? defaultWait;
  const backoffMs =
    options.backoffMs ?? OPFS_CLEANUP_BACKOFF_MS;

  let lastError: Error | null = null;
  let remaining: string[] = [];

  for (let index = 0; index < backoffMs.length; index += 1) {
    const delay = backoffMs[index] ?? 0;

    if (delay > 0) {
      await wait(delay);
    }

    try {
      const root = await getDirectory();
      const before = await listRemotionEntries(root);

      for (const name of before) {
        try {
          await root.removeEntry(name);
        } catch (error) {
          lastError = asError(error);
        }
      }

      remaining = await listRemotionEntries(root);

      if (remaining.length === 0) {
        return {
          ok: true,
          attempts: index + 1,
        };
      }
    } catch (error) {
      lastError = asError(error);
    }
  }

  return {
    ok: false,
    attempts: backoffMs.length,
    error: lastError,
    remaining,
  };
};

export const evaluateBrowserRenderPolicy = (
  story: Story,
  dependencies: BrowserStoryPolicyDependencies = {},
) => evaluateBrowserStoryPolicy(story, dependencies);

export const canDownloadBrowserRenderSnapshot = (
  snapshot: Story,
  activeStory: Story,
  inputBlocked: boolean,
): boolean =>
  !inputBlocked &&
  storiesSemanticallyEqual(snapshot, activeStory);

export const renderStoryMediaOnWeb = async (
  story: Story,
  options: {
    signal: AbortSignal;
    onProgress?: (progress: RenderMediaOnWebProgress) => void;
    licenseKey?: string | null;
    render?: RenderFunction;
    component?: ComponentType<{story: Story}>;
  },
): Promise<RenderMediaOnWebResult> => {
  const policy = evaluateBrowserRenderPolicy(story);

  if (!policy.eligible) {
    throw new Error(
      `Active Story failed the browser render policy recheck: ${policy.message}`,
    );
  }

  const render = options.render ?? renderMediaOnWeb;
  const component =
    options.component ?? (await import("../Video.tsx")).ToraVideo;

  return render({
    composition: {
      id: "ToraVideo",
      component,
      durationInFrames: policy.totalFrames,
      fps: VIDEO_FPS,
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      calculateMetadata: null,
      defaultProps: {story},
    },
    inputProps: {story},
    container: "mp4",
    videoCodec: "h264",
    muted: true,
    outputTarget: "web-fs",
    signal: options.signal,
    onProgress: options.onProgress,
    licenseKey: options.licenseKey ?? null,
    allowHtmlInCanvas: false,
  });
};

const cleanupSafely = async (
  cleanup: () => Promise<OpfsCleanupResult>,
): Promise<OpfsCleanupResult> => {
  try {
    return await cleanup();
  } catch (error) {
    return {
      ok: false,
      attempts: 1,
      error: asError(error),
      remaining: [],
    };
  }
};

export const startBrowserRenderTransaction = async (
  story: Story,
  options: {
    signal: AbortSignal;
    onProgress?: (progress: RenderMediaOnWebProgress) => void;
    licenseKey?: string | null;
    checkCapability?: () => Promise<BrowserRenderCapability>;
    acquireLock?: () => Promise<BrowserRenderLockLease>;
    cleanup?: () => Promise<OpfsCleanupResult>;
    renderStory?: typeof renderStoryMediaOnWeb;
    materializeBlob?: (blob: Blob) => Promise<Blob>;
    consumeBlob?: (blob: Blob) => void | Promise<void>;
  },
): Promise<BrowserRenderTransactionOutcome> => {
  const checkCapability =
    options.checkCapability ?? (() => checkBrowserRenderCapability());
  const capability = await checkCapability();

  if (capability.kind !== "ready") {
    return {
      kind: "unsupported",
      message: capability.message,
    };
  }

  const acquireLock =
    options.acquireLock ?? (() => acquireBrowserRenderLock());
  const lease = await acquireLock();

  if (lease.mode === "busy") {
    return {kind: "busy"};
  }

  if (lease.mode === "unavailable") {
    return {
      kind: "unsupported",
      message: lease.message,
    };
  }

  const cleanup =
    options.cleanup ?? (() => cleanupRemotionOpfsUntilEmpty());
  const preCleanup = await cleanupSafely(cleanup);

  if (!preCleanup.ok) {
    return {
      kind: "cleanup-blocked",
      stage: "pre",
      lease,
      pending: null,
      cleanup: preCleanup,
    };
  }

  if (options.signal.aborted) {
    lease.release();
    return {kind: "cancelled"};
  }

  let pending: BrowserRenderPendingOutcome;

  try {
    const renderStory = options.renderStory ?? renderStoryMediaOnWeb;
    const result = await renderStory(story, {
      signal: options.signal,
      onProgress: options.onProgress,
      licenseKey: options.licenseKey,
    });
    const webFsBlob = await result.getBlob();

    if (options.signal.aborted) {
      pending = {kind: "cancelled"};
    } else {
      const materializeBlob =
        options.materializeBlob ?? materializeBrowserDownloadBlob;
      const blob = await materializeBlob(webFsBlob);

      if (options.signal.aborted) {
        pending = {kind: "cancelled"};
      } else {
        const consumed = options.consumeBlob !== undefined;

        if (options.consumeBlob !== undefined) {
          await options.consumeBlob(blob);
        }

        pending = {
          kind: "success",
          blob,
          consumed,
        };
      }
    }
  } catch (error) {
    pending = options.signal.aborted
      ? {kind: "cancelled"}
      : {
          kind: "failure",
          error: asError(error),
        };
  }

  const postCleanup = await cleanupSafely(cleanup);

  if (
    options.signal.aborted &&
    pending.kind === "success" &&
    !pending.consumed
  ) {
    pending = {kind: "cancelled"};
  }

  if (!postCleanup.ok) {
    return {
      kind: "cleanup-blocked",
      stage: "post",
      lease,
      pending,
      cleanup: postCleanup,
    };
  }

  lease.release();
  return pending;
};

export const retryBrowserRenderCleanup = async (
  blocked: BrowserRenderCleanupBlocked,
  cleanup: () => Promise<OpfsCleanupResult> = () =>
    cleanupRemotionOpfsUntilEmpty(),
): Promise<BrowserRenderCleanupRetryOutcome> => {
  const result = await cleanupSafely(cleanup);

  if (!result.ok) {
    return {
      ...blocked,
      cleanup: result,
    };
  }

  blocked.lease.release();

  if (blocked.stage === "pre") {
    return {kind: "pre-cleanup-cleared"};
  }

  return (
    blocked.pending ?? {
      kind: "failure",
      error: new Error(
        "Browser render cleanup completed without a pending render outcome.",
      ),
    }
  );
};
