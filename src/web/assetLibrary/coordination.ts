import {
  isLocalAssetRef,
  SHA256_HEX_PATTERN,
  type LocalAssetRef,
} from "../../localAssets/refs.ts";
import {ASSET_LIBRARY_CHANNEL, ASSET_LIBRARY_LOCK} from "./constants.ts";

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
