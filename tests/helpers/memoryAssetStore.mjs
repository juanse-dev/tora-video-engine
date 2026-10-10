import {
  parseLocalAssetRef,
  buildLocalAssetRef,
  localAssetRefPrefix,
} from "../../src/localAssets/refs.ts";
import {
  decodeAssetRow,
  decodeBlobRecord,
  decodePayloadMeta,
  decodeThumbnail,
} from "../../src/web/assetLibrary/records.ts";

/**
 * In-memory `AssetLibraryStore` for Node tests (ASSET-002 D-5).
 *
 * Raw values live in four Maps keyed exactly like the IndexedDB stores
 * (`assets`: full ref; `payloadMeta` / `blobs` / `thumbnails`: digest) and are
 * decoded on every read with the real decoders, so injected corrupt values
 * behave like corrupt rows in IndexedDB.
 *
 * Public API (besides the `AssetLibraryStore` methods):
 * - `stores`: `{assets, payloadMeta, blobs, thumbnails}` raw Maps (inspect freely).
 * - `reads`: `{assets, payloadMeta, blobs, thumbnails}` counters, incremented by
 *   `getAssetRow` / `getPayloadMeta` / `getBlob` / `getThumbnail` (one per call)
 *   and by `listAssets` (one per row RETURNED in `reads.assets`; skipped
 *   non-canonical keys are not counted). Reads done inside `apply` and
 *   `countAssets` are NOT counted. `resetReads()` zeroes all counters.
 * - `setRaw(storeName, key, value)` / `getRaw` / `deleteRaw` / `hasRaw` /
 *   `keys(storeName)`: raw injection and inspection, bypassing the decoders.
 * - `failNextApply(error?, count = 1)`: the next `count` `apply` calls reject
 *   with `error` (default: a `QuotaExceededError` DOMException) after the
 *   transaction has run, and leave every store unchanged (all-or-nothing).
 *   `clearApplyFailure()` cancels pending failures.
 * - `applyCalls`: array of the mutations passed to `apply` (successful or not).
 * - `snapshot()`: plain object copy of the four Maps (for "unchanged" asserts).
 * - `closed`: true after `close()`; every operation then rejects.
 */

export const STORE_NAMES = ["assets", "payloadMeta", "blobs", "thumbnails"];

export const createQuotaExceededError = () =>
  new DOMException("The quota has been exceeded.", "QuotaExceededError");

const mutationDigest = (ref) => {
  const parsed = parseLocalAssetRef(ref);

  if (parsed === null) {
    throw new Error(`Not a canonical local asset ref: ${String(ref)}`);
  }

  return parsed;
};

export const createMemoryAssetStore = () => {
  const stores = {
    assets: new Map(),
    payloadMeta: new Map(),
    blobs: new Map(),
    thumbnails: new Map(),
  };
  const reads = {assets: 0, payloadMeta: 0, blobs: 0, thumbnails: 0};
  const applyCalls = [];
  let pendingFailures = [];
  let closed = false;

  const assertOpen = () => {
    if (closed) {
      throw new Error("Memory asset store is closed");
    }
  };

  const assertStoreName = (name) => {
    if (!STORE_NAMES.includes(name)) {
      throw new Error(`Unknown store: ${String(name)}`);
    }
  };

  const canonicalKeys = (category) => {
    const prefix = localAssetRefPrefix(category);

    return [...stores.assets.keys()]
      .filter(
        (key) =>
          typeof key === "string" &&
          key.startsWith(prefix) &&
          parseLocalAssetRef(key)?.category === category,
      )
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  };

  /** One simulated read-write transaction over a staged copy of all stores. */
  const runTransaction = (mutation) => {
    const staged = {};

    for (const name of STORE_NAMES) {
      staged[name] = new Map(stores[name]);
    }

    const {digest, category} = mutationDigest(mutation.ref);
    let result;

    if (mutation.kind === "import") {
      const existing = decodeAssetRow(mutation.ref, staged.assets.get(mutation.ref));
      const keep = existing.status === "present" ? existing.value : null;

      staged.assets.set(mutation.ref, {
        label: keep?.label ?? mutation.defaultLabel,
        originalFilename: mutation.originalFilename,
        createdAt: keep?.createdAt ?? mutation.createdAt,
      });
      staged.payloadMeta.set(digest, {...mutation.payloadMeta});
      staged.blobs.set(digest, {blob: mutation.blob});
      staged.thumbnails.set(digest, {...mutation.thumbnail});
      result = {
        kind: "imported",
        ref: mutation.ref,
        created: existing.status === "absent",
      };
    } else if (mutation.kind === "rename") {
      const existing = decodeAssetRow(mutation.ref, staged.assets.get(mutation.ref));

      if (existing.status === "absent") {
        result = {kind: "not-found", ref: mutation.ref};
      } else {
        staged.assets.set(
          mutation.ref,
          existing.status === "present"
            ? {...existing.value, label: mutation.label}
            : {
                label: mutation.label,
                originalFilename: "",
                createdAt: new Date().toISOString(),
              },
        );
        result = {kind: "renamed", ref: mutation.ref};
      }
    } else if (mutation.kind === "delete") {
      if (!staged.assets.has(mutation.ref)) {
        result = {kind: "not-found", ref: mutation.ref};
      } else {
        staged.assets.delete(mutation.ref);

        const otherCategory = category === "pose" ? "background" : "pose";
        const otherRef = buildLocalAssetRef(otherCategory, digest);
        const payloadRemoved = !staged.assets.has(otherRef);

        if (payloadRemoved) {
          staged.payloadMeta.delete(digest);
          staged.blobs.delete(digest);
          staged.thumbnails.delete(digest);
        }

        result = {kind: "deleted", ref: mutation.ref, payloadRemoved};
      }
    } else {
      throw new Error(`Unknown mutation kind: ${String(mutation.kind)}`);
    }

    return {staged, result};
  };

  return {
    stores,
    reads,
    applyCalls,

    get closed() {
      return closed;
    },

    resetReads() {
      for (const name of STORE_NAMES) {
        reads[name] = 0;
      }
    },

    setRaw(storeName, key, value) {
      assertStoreName(storeName);
      stores[storeName].set(key, value);
    },

    getRaw(storeName, key) {
      assertStoreName(storeName);
      return stores[storeName].get(key);
    },

    hasRaw(storeName, key) {
      assertStoreName(storeName);
      return stores[storeName].has(key);
    },

    deleteRaw(storeName, key) {
      assertStoreName(storeName);
      stores[storeName].delete(key);
    },

    keys(storeName) {
      assertStoreName(storeName);
      return [...stores[storeName].keys()];
    },

    snapshot() {
      return Object.fromEntries(
        STORE_NAMES.map((name) => [name, new Map(stores[name])]),
      );
    },

    failNextApply(error = createQuotaExceededError(), count = 1) {
      pendingFailures = Array.from({length: count}, () => error);
    },

    clearApplyFailure() {
      pendingFailures = [];
    },

    async getAssetRow(ref) {
      assertOpen();
      reads.assets += 1;
      return decodeAssetRow(ref, stores.assets.get(ref));
    },

    async getPayloadMeta(digest) {
      assertOpen();
      reads.payloadMeta += 1;
      return decodePayloadMeta(digest, stores.payloadMeta.get(digest));
    },

    async getBlob(digest) {
      assertOpen();
      reads.blobs += 1;
      return decodeBlobRecord(digest, stores.blobs.get(digest));
    },

    async getThumbnail(digest) {
      assertOpen();
      reads.thumbnails += 1;
      return decodeThumbnail(digest, stores.thumbnails.get(digest));
    },

    async listAssets(category, cursor, limit) {
      assertOpen();

      let keys = canonicalKeys(category);

      if (cursor.after !== undefined) {
        keys = keys.filter((key) => key > cursor.after);
      }

      if (cursor.before !== undefined) {
        keys = keys.filter((key) => key < cursor.before);
        keys = keys.slice(Math.max(0, keys.length - limit));
      } else {
        keys = keys.slice(0, limit);
      }

      reads.assets += keys.length;

      return keys.map((key) => ({
        ref: key,
        row: decodeAssetRow(key, stores.assets.get(key)),
      }));
    },

    async countAssets(category) {
      assertOpen();
      return canonicalKeys(category).length;
    },

    async apply(mutation) {
      assertOpen();
      applyCalls.push(mutation);

      const {staged, result} = runTransaction(mutation);
      const failure = pendingFailures.shift();

      if (failure !== undefined) {
        // The "commit" fails: staged writes are discarded, stores stay unchanged.
        throw failure;
      }

      for (const name of STORE_NAMES) {
        stores[name].clear();

        for (const [key, value] of staged[name]) {
          stores[name].set(key, value);
        }
      }

      return result;
    },

    close() {
      closed = true;
    },
  };
};

/**
 * Minimal Web Locks fake: per-name FIFO queue, exclusive/shared modes, abort
 * while waiting rejects with AbortError. `requests` records every request as
 * `{name, mode, granted}`; `held(name)` reports the current holders.
 */
export const createMemoryLockManager = () => {
  const names = new Map();
  const requests = [];

  const stateFor = (name) => {
    let state = names.get(name);

    if (state === undefined) {
      state = {exclusive: false, shared: 0, queue: []};
      names.set(name, state);
    }

    return state;
  };

  const canGrant = (state, mode) =>
    mode === "exclusive"
      ? !state.exclusive && state.shared === 0
      : !state.exclusive;

  const pump = (state) => {
    while (state.queue.length > 0 && canGrant(state, state.queue[0].mode)) {
      state.queue.shift().grant();
    }
  };

  return {
    requests,

    held(name) {
      const state = names.get(name);
      return state === undefined
        ? {exclusive: false, shared: 0}
        : {exclusive: state.exclusive, shared: state.shared};
    },

    request(name, optionsOrCallback, maybeCallback) {
      const options =
        typeof optionsOrCallback === "function" ? {} : optionsOrCallback ?? {};
      const callback =
        typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      const mode = options.mode ?? "exclusive";
      const record = {name, mode, granted: false};
      requests.push(record);

      const state = stateFor(name);

      return new Promise((resolve, reject) => {
        const abortError = () =>
          options.signal?.reason ?? new DOMException("Aborted", "AbortError");

        if (options.signal?.aborted) {
          reject(abortError());
          return;
        }

        const entry = {
          mode,
          grant: async () => {
            options.signal?.removeEventListener("abort", onAbort);
            record.granted = true;

            if (mode === "exclusive") {
              state.exclusive = true;
            } else {
              state.shared += 1;
            }

            try {
              resolve(await callback({name, mode}));
            } catch (error) {
              reject(error);
            } finally {
              if (mode === "exclusive") {
                state.exclusive = false;
              } else {
                state.shared -= 1;
              }

              pump(state);
            }
          },
        };
        const onAbort = () => {
          const index = state.queue.indexOf(entry);

          if (index !== -1) {
            state.queue.splice(index, 1);
            reject(abortError());
          }
        };

        options.signal?.addEventListener("abort", onAbort);
        state.queue.push(entry);
        pump(state);
      });
    },
  };
};

/**
 * Tiny BroadcastChannel fake: channels with the same name receive each other's
 * messages (never their own), asynchronously via `queueMicrotask`.
 */
export const createMemoryBroadcastChannelClass = () => {
  const channels = new Map();

  class MemoryBroadcastChannel {
    constructor(name) {
      this.name = name;
      this.closed = false;
      this.listeners = [];
      this.onmessage = null;

      if (!channels.has(name)) {
        channels.set(name, new Set());
      }

      channels.get(name).add(this);
    }

    addEventListener(type, listener) {
      if (type === "message") {
        this.listeners.push(listener);
      }
    }

    postMessage(data) {
      if (this.closed) {
        throw new DOMException("Channel is closed", "InvalidStateError");
      }

      for (const peer of channels.get(this.name)) {
        if (peer !== this && !peer.closed) {
          queueMicrotask(() => {
            for (const listener of peer.listeners) {
              listener({data});
            }
            peer.onmessage?.({data});
          });
        }
      }
    }

    close() {
      this.closed = true;
      channels.get(this.name)?.delete(this);
    }
  }

  return MemoryBroadcastChannel;
};
