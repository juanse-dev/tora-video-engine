import {
  buildLocalAssetRef,
  parseLocalAssetRef,
  localAssetRefPrefix,
  type LocalAssetCategory,
  type LocalAssetRef,
} from "../../localAssets/refs.ts";
import type {PayloadMetadata} from "../../localAssets/readiness.ts";
import {
  ASSET_DB_NAME,
  ASSET_DB_VERSION,
  ASSET_LIBRARY_LOCK,
} from "./constants.ts";
import {
  decodeAssetRow,
  decodeBlobRecord,
  decodePayloadMeta,
  decodeThumbnail,
  type AssetRow,
  type Decoded,
  type ThumbnailRecord,
} from "./records.ts";
import type {
  AssetLibraryMutation,
  AssetLibraryMutationResult,
  AssetLibraryStore,
  AssetPageCursor,
} from "./store.ts";

export type LocalAssetLibraryErrorCode = "storage-full" | "storage-error";

/**
 * Storage failure from the IndexedDB adapter. A `storage-full` error keeps the
 * name "QuotaExceededError" so callers that classify by `error.name` (the
 * import pipeline) and callers that read `code` agree.
 */
export class LocalAssetLibraryError extends Error {
  code: LocalAssetLibraryErrorCode;

  constructor(
    code: LocalAssetLibraryErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.code = code;
    this.name =
      code === "storage-full" ? "QuotaExceededError" : "LocalAssetLibraryError";

    if (cause !== undefined) {
      (this as {cause?: unknown}).cause = cause;
    }
  }
}

/** Maps a quota failure to `storage-full` and every other failure to `storage-error`. */
export const toLocalAssetLibraryError = (
  error: unknown,
): LocalAssetLibraryError => {
  if (error instanceof LocalAssetLibraryError) {
    return error;
  }

  const name = (error as {name?: unknown} | null)?.name;

  if (name === "QuotaExceededError") {
    return new LocalAssetLibraryError(
      "storage-full",
      "Browser storage is full. Free up space and try again.",
      error,
    );
  }

  const detail = (error as {message?: unknown} | null)?.message;

  return new LocalAssetLibraryError(
    "storage-error",
    typeof detail === "string" && detail !== ""
      ? `My assets storage failed: ${detail}`
      : "My assets storage failed.",
    error,
  );
};

type StoreName = "assets" | "payloadMeta" | "blobs" | "thumbnails";

const STORE_NAMES: StoreName[] = [
  "assets",
  "payloadMeta",
  "blobs",
  "thumbnails",
];

export type IndexedDbAssetStoreDeps = {
  indexedDB?: IDBFactory;
  locks?: LockManager;
  /** Called when the open request is blocked by another tab's older connection. */
  onBlocked?: () => void;
};

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * The open request that may create or upgrade the database runs while holding
 * the library lock exclusively. An IDBOpenDBRequest cannot be cancelled, so the
 * lock is kept until the request settles, including while it is blocked.
 */
const openConnection = (
  factory: IDBFactory,
  locks: LockManager,
  onBlocked: (() => void) | undefined,
): Promise<IDBDatabase> =>
  locks.request(
    ASSET_LIBRARY_LOCK,
    {mode: "exclusive"},
    () =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(ASSET_DB_NAME, ASSET_DB_VERSION);

        request.onupgradeneeded = () => {
          const database = request.result;

          for (const name of STORE_NAMES) {
            if (!database.objectStoreNames.contains(name)) {
              database.createObjectStore(name);
            }
          }
        };
        request.onblocked = () => {
          onBlocked?.();
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  ) as Promise<IDBDatabase>;

const buildRange = (
  category: LocalAssetCategory,
  cursor: AssetPageCursor,
): IDBKeyRange | null => {
  const prefix = localAssetRefPrefix(category);
  let lower = prefix;
  let lowerOpen = false;
  let upper = `${prefix}\uffff`;
  let upperOpen = false;

  if (cursor.after !== undefined && cursor.after >= lower) {
    lower = cursor.after;
    lowerOpen = true;
  }

  if (cursor.before !== undefined && cursor.before <= upper) {
    upper = cursor.before;
    upperOpen = true;
  }

  if (lower > upper || (lower === upper && (lowerOpen || upperOpen))) {
    return null;
  }

  return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
};

const isCanonicalKeyOf = (
  key: IDBValidKey,
  category: LocalAssetCategory,
): key is LocalAssetRef =>
  typeof key === "string" && parseLocalAssetRef(key)?.category === category;

const refParts = (ref: string) => {
  const parsed = parseLocalAssetRef(ref);

  if (parsed === null) {
    throw new Error(`Not a canonical local asset ref: ${String(ref)}`);
  }

  return parsed;
};

export const openIndexedDbAssetStore = async (
  deps: IndexedDbAssetStoreDeps = {},
): Promise<AssetLibraryStore> => {
  const factory =
    deps.indexedDB ??
    (typeof indexedDB === "undefined" ? undefined : indexedDB);
  const locks =
    deps.locks ?? (typeof navigator === "undefined" ? undefined : navigator.locks);

  if (factory === undefined) {
    throw new Error("IndexedDB is not available");
  }

  if (typeof locks?.request !== "function") {
    throw new Error("Web Locks are not available");
  }

  const database = await openConnection(factory, locks, deps.onBlocked);
  let unusable: LocalAssetLibraryError | null = null;

  // Never hold up another tab's upgrade: close at once, and refuse later calls.
  database.onversionchange = () => {
    unusable ??= new LocalAssetLibraryError(
      "storage-error",
      "My assets was upgraded in another tab. Reload this page to continue.",
    );
    database.close();
  };
  database.onclose = () => {
    unusable ??= new LocalAssetLibraryError(
      "storage-error",
      "The My assets connection was closed unexpectedly. Reload this page to continue.",
    );
  };

  const transact = <T>(
    storeNames: StoreName | StoreName[],
    mode: IDBTransactionMode,
    work: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;

      try {
        if (unusable !== null) {
          throw unusable;
        }

        transaction = database.transaction(storeNames, mode);
      } catch (error) {
        reject(toLocalAssetLibraryError(error));
        return;
      }

      let outcome: {value: T} | null = null;
      let failure: unknown;

      transaction.oncomplete = () => {
        if (outcome !== null) {
          resolve(outcome.value);
        } else {
          reject(
            toLocalAssetLibraryError(
              failure ?? new Error("Transaction ended without a result"),
            ),
          );
        }
      };
      transaction.onabort = () => {
        reject(
          toLocalAssetLibraryError(
            transaction.error ??
              failure ??
              new DOMException("Transaction aborted", "AbortError"),
          ),
        );
      };

      const fail = (error: unknown) => {
        failure = error;

        try {
          // Without an explicit abort the writes queued so far would commit.
          transaction.abort();
        } catch {
          // Already finished or aborting; the abort event reports the failure.
        }
      };

      try {
        work(transaction).then((value) => {
          outcome = {value};
        }, fail);
      } catch (error) {
        fail(error);
      }
    });

  const assertUsable = () => {
    if (unusable !== null) {
      throw unusable;
    }
  };

  const getValue = (storeName: StoreName, key: string): Promise<unknown> =>
    transact(storeName, "readonly", (transaction) =>
      requestToPromise<unknown>(transaction.objectStore(storeName).get(key)),
    );

  const applyMutation = async (
    mutation: AssetLibraryMutation,
  ): Promise<AssetLibraryMutationResult> => {
    const {digest, category} = refParts(mutation.ref);

    if (
      mutation.kind !== "import" &&
      mutation.kind !== "rename" &&
      mutation.kind !== "delete"
    ) {
      throw new Error(
        `Unknown mutation kind: ${String((mutation as {kind?: unknown}).kind)}`,
      );
    }

    return transact(STORE_NAMES, "readwrite", async (transaction) => {
      const assets = transaction.objectStore("assets");

      if (mutation.kind === "import") {
        const existing = decodeAssetRow(
          mutation.ref,
          await requestToPromise<unknown>(assets.get(mutation.ref)),
        );
        const keep = existing.status === "present" ? existing.value : null;
        const payloadMeta: PayloadMetadata = {...mutation.payloadMeta};
        const thumbnail: ThumbnailRecord = {...mutation.thumbnail};

        await requestToPromise(
          assets.put(
            {
              label: keep?.label ?? mutation.defaultLabel,
              originalFilename: mutation.originalFilename,
              createdAt: keep?.createdAt ?? mutation.createdAt,
            },
            mutation.ref,
          ),
        );
        await requestToPromise(
          transaction.objectStore("payloadMeta").put(payloadMeta, digest),
        );
        await requestToPromise(
          transaction.objectStore("blobs").put({blob: mutation.blob}, digest),
        );
        await requestToPromise(
          transaction.objectStore("thumbnails").put(thumbnail, digest),
        );

        return {
          kind: "imported",
          ref: mutation.ref,
          created: existing.status === "absent",
        };
      }

      if (mutation.kind === "rename") {
        const existing = decodeAssetRow(
          mutation.ref,
          await requestToPromise<unknown>(assets.get(mutation.ref)),
        );

        if (existing.status === "absent") {
          return {kind: "not-found", ref: mutation.ref};
        }

        const row: AssetRow =
          existing.status === "present"
            ? {...existing.value, label: mutation.label}
            : {
                label: mutation.label,
                originalFilename: "",
                createdAt: new Date().toISOString(),
              };

        await requestToPromise(assets.put(row, mutation.ref));
        return {kind: "renamed", ref: mutation.ref};
      }

      if (
        (await requestToPromise<IDBValidKey | undefined>(
          assets.getKey(mutation.ref),
        )) === undefined
      ) {
        return {kind: "not-found", ref: mutation.ref};
      }

      await requestToPromise(assets.delete(mutation.ref));

      const otherRef = buildLocalAssetRef(
        category === "pose" ? "background" : "pose",
        digest,
      );
      // A corrupt row in the other category still protects the shared payload.
      const payloadRemoved =
        (await requestToPromise<IDBValidKey | undefined>(
          assets.getKey(otherRef),
        )) === undefined;

      if (payloadRemoved) {
        for (const name of ["payloadMeta", "blobs", "thumbnails"] as const) {
          await requestToPromise(transaction.objectStore(name).delete(digest));
        }
      }

      return {kind: "deleted", ref: mutation.ref, payloadRemoved};
    });
  };

  return {
    async getAssetRow(ref): Promise<Decoded<AssetRow>> {
      return decodeAssetRow(ref, await getValue("assets", ref));
    },

    async getPayloadMeta(digest) {
      return decodePayloadMeta(digest, await getValue("payloadMeta", digest));
    },

    async getBlob(digest) {
      return decodeBlobRecord(digest, await getValue("blobs", digest));
    },

    async getThumbnail(digest) {
      return decodeThumbnail(digest, await getValue("thumbnails", digest));
    },

    async listAssets(category, cursor, limit) {
      assertUsable();

      const range = buildRange(category, cursor);

      if (range === null || !(limit > 0)) {
        return [];
      }

      const backwards = cursor.before !== undefined;
      const rows = await transact("assets", "readonly", (transaction) =>
        new Promise<Array<{ref: LocalAssetRef; row: Decoded<AssetRow>}>>(
          (resolve, reject) => {
            const found: Array<{ref: LocalAssetRef; row: Decoded<AssetRow>}> =
              [];
            const request = transaction
              .objectStore("assets")
              .openCursor(range, backwards ? "prev" : "next");

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              try {
                const current = request.result;

                if (current === null) {
                  resolve(found);
                  return;
                }

                // Non-canonical keys are skipped and never count toward the limit.
                if (isCanonicalKeyOf(current.primaryKey, category)) {
                  found.push({
                    ref: current.primaryKey,
                    row: decodeAssetRow(current.primaryKey, current.value),
                  });

                  if (found.length >= limit) {
                    resolve(found);
                    return;
                  }
                }

                current.continue();
              } catch (error) {
                reject(error);
              }
            };
          },
        ),
      );

      return backwards ? rows.reverse() : rows;
    },

    async countAssets(category) {
      assertUsable();

      const range = buildRange(category, {});

      if (range === null) {
        return 0;
      }

      return transact("assets", "readonly", (transaction) =>
        new Promise<number>((resolve, reject) => {
          let count = 0;
          const request = transaction
            .objectStore("assets")
            .openKeyCursor(range, "next");

          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const current = request.result;

            if (current === null) {
              resolve(count);
              return;
            }

            if (isCanonicalKeyOf(current.primaryKey, category)) {
              count += 1;
            }

            current.continue();
          };
        }),
      );
    },

    apply: applyMutation,

    close() {
      unusable ??= new LocalAssetLibraryError(
        "storage-error",
        "The My assets library is closed.",
      );
      database.close();
    },
  };
};
