import {
  isLocalAssetRef,
  SHA256_HEX_PATTERN,
  type LocalAssetRef,
} from "../../localAssets/refs.ts";
import {ASSET_LIBRARY_CHANNEL, ASSET_LIBRARY_LOCK} from "./constants.ts";
import {openIndexedDbAssetStore} from "./indexedDbStore.ts";
import type {AssetLibraryStore} from "./store.ts";

export const withAssetLibraryLock = <T>(
  locks: LockManager,
  mode: "exclusive" | "shared",
  task: () => Promise<T>,
  options?: {signal?: AbortSignal}, // forwarded to locks.request: aborting while still waiting rejects with AbortError
): Promise<T> => {
  const requestOptions: LockOptions = {mode};

  if (options?.signal !== undefined) {
    requestOptions.signal = options.signal;
  }

  return locks.request(ASSET_LIBRARY_LOCK, requestOptions, () =>
    task(),
  ) as Promise<T>;
};

export type AssetLibraryMessage = {
  type: "asset-library-changed";
  refs: LocalAssetRef[];
  digests: string[];
};

const parseMessage = (data: unknown): AssetLibraryMessage | null => {
  if (typeof data !== "object" || data === null) {
    return null;
  }

  const candidate = data as {type?: unknown; refs?: unknown; digests?: unknown};

  if (
    candidate.type !== "asset-library-changed" ||
    !Array.isArray(candidate.refs) ||
    !Array.isArray(candidate.digests)
  ) {
    return null;
  }

  // The message is only a refresh hint; never trust its contents beyond shape.
  return {
    type: "asset-library-changed",
    refs: candidate.refs.filter(
      (ref): ref is LocalAssetRef =>
        typeof ref === "string" && isLocalAssetRef(ref),
    ),
    digests: candidate.digests.filter(
      (digest): digest is string =>
        typeof digest === "string" && SHA256_HEX_PATTERN.test(digest),
    ),
  };
};

export const createAssetLibraryChannel = (
  onMessage: (message: AssetLibraryMessage) => void,
  deps?: {BroadcastChannel?: typeof BroadcastChannel},
): {post(message: AssetLibraryMessage): void; close(): void} => {
  const ChannelConstructor =
    deps?.BroadcastChannel ??
    (typeof BroadcastChannel === "undefined" ? undefined : BroadcastChannel);

  if (ChannelConstructor === undefined) {
    // Best-effort signal only: without BroadcastChannel tabs refresh on focus.
    return {post() {}, close() {}};
  }

  const channel = new ChannelConstructor(ASSET_LIBRARY_CHANNEL);
  const handle = (event: MessageEvent) => {
    const message = parseMessage(event.data);

    if (message !== null) {
      onMessage(message);
    }
  };

  if (typeof channel.addEventListener === "function") {
    channel.addEventListener("message", handle);
  } else {
    channel.onmessage = handle;
  }

  return {
    post(message) {
      try {
        channel.postMessage(message);
      } catch {
        // BroadcastChannel is a best-effort refresh signal, never a barrier.
      }
    },
    close() {
      try {
        channel.close();
      } catch {
        // Already closed.
      }
    },
  };
};

let persistentStorageRequested = false;

/**
 * Best-effort, once per page session: asks the browser to keep this origin's
 * storage (so the asset library is not evicted under pressure). Never throws,
 * and a denied or failed request is not retried.
 */
export const requestPersistentStorageOnce = async (deps?: {
  storage?: StorageManager;
}): Promise<void> => {
  if (persistentStorageRequested) {
    return;
  }

  const storage = deps?.storage ?? globalThis.navigator?.storage;

  if (storage === undefined || typeof storage.persist !== "function") {
    return;
  }

  persistentStorageRequested = true;

  try {
    if (typeof storage.persisted === "function" && (await storage.persisted())) {
      return;
    }

    await storage.persist();
  } catch {
    // Persistence is a courtesy request; the library works without it.
  }
};

/** Test-only: forget that persistence was already requested. */
export const resetPersistentStorageRequestForTests = (): void => {
  persistentStorageRequested = false;
};

// --- Library status and opening (ASSET-002 task 6) ---------------------------

export type AssetLibraryStatus =
  | {kind: "disabled"; message: string} // no Web Locks (D-3)
  | {kind: "unavailable"; message: string} // no indexedDB, or open failed
  | {kind: "ready"; store: AssetLibraryStore};

const WEB_LOCKS_REQUIRED_MESSAGE =
  "My assets needs a browser with Web Locks support. Local assets in this Story can't be shown or rendered here.";
const UPGRADE_BLOCKED_MESSAGE =
  "Close other Tora tabs to finish updating My assets.";
const STORAGE_UNAVAILABLE_MESSAGE =
  "My assets couldn't be opened in this browser. Check that site storage is allowed (not blocked), then reload the page. Local assets in this Story can't be shown or rendered until then.";
const NEWER_VERSION_MESSAGE =
  "My assets was updated by a newer version of Tora. Reload this page to continue.";

/**
 * Resolves with the first status. If the database open is blocked by another
 * tab, that status is `unavailable` ("Close other Tora tabs...") and the open
 * keeps waiting inside the exclusive library lock; its outcome (`ready`, or
 * `unavailable` on failure) is then reported through `onStatusChange`, which
 * also receives the blocked status itself.
 */
export const openAssetLibrary = async (deps?: {
  locks?: LockManager;
  indexedDB?: IDBFactory;
  /** Later status changes, e.g. blocked upgrade -> ready. App stores each in useState. */
  onStatusChange?: (status: AssetLibraryStatus) => void;
}): Promise<AssetLibraryStatus> => {
  const locks =
    deps?.locks ?? (typeof navigator === "undefined" ? undefined : navigator.locks);

  if (typeof locks?.request !== "function") {
    return {kind: "disabled", message: WEB_LOCKS_REQUIRED_MESSAGE};
  }

  const factory =
    deps?.indexedDB ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);

  if (factory === undefined) {
    return {kind: "unavailable", message: STORAGE_UNAVAILABLE_MESSAGE};
  }

  const onStatusChange = deps?.onStatusChange;

  return new Promise<AssetLibraryStatus>((resolve) => {
    let initialReported = false;
    const report = (status: AssetLibraryStatus) => {
      if (!initialReported) {
        initialReported = true;
        resolve(status);
      } else {
        onStatusChange?.(status);
      }
    };

    openIndexedDbAssetStore({
      indexedDB: factory,
      locks,
      onBlocked: () => {
        const blocked: AssetLibraryStatus = {
          kind: "unavailable",
          message: UPGRADE_BLOCKED_MESSAGE,
        };

        if (!initialReported) {
          initialReported = true;
          resolve(blocked);
        }

        onStatusChange?.(blocked);
      },
    }).then(
      (store) => report({kind: "ready", store}),
      (error: unknown) =>
        report({
          kind: "unavailable",
          message:
            (error as {name?: unknown} | null)?.name === "VersionError"
              ? NEWER_VERSION_MESSAGE
              : STORAGE_UNAVAILABLE_MESSAGE,
        }),
    );
  });
};
