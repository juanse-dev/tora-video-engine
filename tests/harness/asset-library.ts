// Test harness page for the IndexedDB asset library (ASSET-002 task 6).
//
// Served only by the vite dev server (port 4174) and driven by
// tests/harness/asset-library-indexeddb.spec.mjs through `window.toraHarness`.
// Nothing in here ships in the production bundle: `vite build` only bundles
// the root index.html.

import {sha256Hex} from "../../src/localAssets/hash.ts";
import {inspectImageBytes} from "../../src/localAssets/imageInspection.ts";
import {
  buildLocalAssetRef,
  parseLocalAssetRef,
  type LocalAssetCategory,
  type LocalAssetRef,
} from "../../src/localAssets/refs.ts";
import {
  ASSET_DB_NAME,
  ASSET_LIBRARY_LOCK,
  MAX_THUMBNAIL_BYTES,
} from "../../src/web/assetLibrary/constants.ts";
import {
  createAssetLibraryChannel,
  openAssetLibrary,
  withAssetLibraryLock,
  type AssetLibraryMessage,
  type AssetLibraryStatus,
} from "../../src/web/assetLibrary/coordination.ts";
import {verifyPayload} from "../../src/web/assetLibrary/integrity.ts";
import {importLocalAsset} from "../../src/web/assetLibrary/importAsset.ts";
import {
  countLocalAssets,
  deleteLocalAsset,
  listLocalAssetPage,
  loadThumbnailForDisplay,
  renameLocalAsset,
  type AssetLibrary,
} from "../../src/web/assetLibrary/library.ts";
import type {
  AssetLibraryMutation,
  AssetPageCursor,
} from "../../src/web/assetLibrary/store.ts";
import type {ThumbnailRecord} from "../../src/web/assetLibrary/records.ts";

type StatusSummary = {kind: AssetLibraryStatus["kind"]; message?: string};
type ThumbnailKind = "valid" | "claims-300" | "oversized" | "bytes-4000";
type StoreName = "assets" | "payloadMeta" | "blobs" | "thumbnails";

const STORE_NAMES: StoreName[] = [
  "assets",
  "payloadMeta",
  "blobs",
  "thumbnails",
];

/* ------------------------------------------------------------ spies/state */

const objectUrlCalls: Array<{size: number; type: string}> = [];
const originalCreateObjectURL = URL.createObjectURL.bind(URL);

URL.createObjectURL = (object: Blob | MediaSource): string => {
  objectUrlCalls.push({
    size: object instanceof Blob ? object.size : -1,
    type: object instanceof Blob ? object.type : "",
  });
  return originalCreateObjectURL(object);
};

const getAllCalls: string[] = [];

for (const method of ["getAll", "getAllKeys"] as const) {
  const original = IDBObjectStore.prototype[method];

  IDBObjectStore.prototype[method] = function (
    this: IDBObjectStore,
    ...args: Parameters<typeof original>
  ) {
    getAllCalls.push(`${this.name}.${method}`);
    return original.apply(this, args);
  } as typeof original;
}

const messages: AssetLibraryMessage[] = [];
const channel = createAssetLibraryChannel((message) => {
  messages.push(message);
});
const statusLog: StatusSummary[] = [];
let currentStatus: AssetLibraryStatus | null = null;
let library: AssetLibrary | null = null;
let statusWaiters: Array<{kind: string; resolve: () => void}> = [];

const summarizeStatus = (status: AssetLibraryStatus): StatusSummary =>
  status.kind === "ready"
    ? {kind: "ready"}
    : {kind: status.kind, message: status.message};

const applyStatus = (status: AssetLibraryStatus) => {
  currentStatus = status;
  statusLog.push(summarizeStatus(status));
  library =
    status.kind === "ready"
      ? {store: status.store, locks: navigator.locks, channel}
      : null;

  const ready = statusWaiters.filter((waiter) => waiter.kind === status.kind);

  statusWaiters = statusWaiters.filter((waiter) => waiter.kind !== status.kind);
  ready.forEach((waiter) => waiter.resolve());
};

const requireLibrary = (): AssetLibrary => {
  if (library === null) {
    throw new Error("Harness library is not open");
  }

  return library;
};

/* -------------------------------------------------------------- raw IDB */

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });

/** Opens the current version of the database (never creates stores). */
const rawOpen = (version?: number): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request =
      version === undefined
        ? indexedDB.open(ASSET_DB_NAME)
        : indexedDB.open(ASSET_DB_NAME, version);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const withRawDatabase = async <T>(
  work: (database: IDBDatabase) => Promise<T>,
): Promise<T> => {
  const database = await rawOpen();

  try {
    return await work(database);
  } finally {
    database.close();
  }
};

const versionedFactory = (version: number): IDBFactory =>
  ({
    open: (name: string) => indexedDB.open(name, version),
  }) as unknown as IDBFactory;

let heldRawConnection: IDBDatabase | null = null;
let releaseHeldLock: (() => void) | null = null;

/* ----------------------------------------------------------- image helpers */

const imageCache = new Map<string, {blob: Blob; bytes: Uint8Array}>();

const makePng = async (
  width: number,
  height: number,
  color: string,
): Promise<{blob: Blob; bytes: Uint8Array}> => {
  const key = `${width}x${height}:${color}`;
  const cached = imageCache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");

  if (context === null) {
    throw new Error("2d canvas context is unavailable");
  }

  context.fillStyle = color;
  context.fillRect(0, 0, width, height);

  const blob = await canvas.convertToBlob({type: "image/png"});
  const entry = {blob, bytes: new Uint8Array(await blob.arrayBuffer())};

  imageCache.set(key, entry);
  return entry;
};

const buildThumbnail = async (kind: ThumbnailKind): Promise<ThumbnailRecord> => {
  switch (kind) {
    case "valid": {
      const {blob} = await makePng(32, 32, "#888888");
      return {blob, mimeType: "image/png", width: 32, height: 32};
    }
    case "claims-300": {
      const {blob} = await makePng(32, 32, "#888888");
      return {blob, mimeType: "image/png", width: 300, height: 300};
    }
    case "oversized": {
      const blob = new Blob([new Uint8Array(MAX_THUMBNAIL_BYTES + 1)], {
        type: "image/png",
      });
      return {blob, mimeType: "image/png", width: 64, height: 64};
    }
    case "bytes-4000": {
      const {blob} = await makePng(4000, 4000, "#444444");
      return {blob, mimeType: "image/png", width: 256, height: 256};
    }
  }
};

type SeedOptions = {
  category: LocalAssetCategory;
  width?: number;
  height?: number;
  color?: string;
  label?: string;
  originalFilename?: string;
  thumbnail?: ThumbnailKind;
  /** Test hook: replace the stored blob with a value IndexedDB cannot clone. */
  nonCloneableBlob?: boolean;
};

const buildImportMutation = async (
  options: SeedOptions,
): Promise<{mutation: AssetLibraryMutation; ref: LocalAssetRef; digest: string}> => {
  const width = options.width ?? 16;
  const height = options.height ?? 16;
  const {bytes} = await makePng(width, height, options.color ?? "#cc3366");
  const inspected = inspectImageBytes(bytes);

  if (!inspected.ok) {
    throw new Error(`Harness image rejected: ${inspected.reason}`);
  }

  const digest = await sha256Hex(bytes);
  const ref = buildLocalAssetRef(options.category, digest);
  const blob = options.nonCloneableBlob
    ? ((() => undefined) as unknown as Blob)
    : new Blob([bytes as BlobPart], {type: inspected.image.mimeType});

  return {
    ref,
    digest,
    mutation: {
      kind: "import",
      ref,
      defaultLabel: options.label ?? "Harness image",
      originalFilename: options.originalFilename ?? "harness.png",
      createdAt: new Date().toISOString(),
      payloadMeta: {
        mimeType: inspected.image.mimeType,
        byteSize: bytes.length,
        width: inspected.image.width,
        height: inspected.image.height,
      },
      blob,
      thumbnail: await buildThumbnail(options.thumbnail ?? "valid"),
    },
  };
};

const describeError = (error: unknown) => {
  const candidate = error as {name?: string; code?: string; message?: string};

  return {
    name: String(candidate?.name),
    code: candidate?.code === undefined ? null : String(candidate.code),
    message: String(candidate?.message),
  };
};

/* -------------------------------------------------------------- the hooks */

const toraHarness = {
  /* ---- library lifecycle ---- */

  /**
   * Opens the library through `openAssetLibrary`. `version` makes the adapter
   * ask the real IDBFactory for another version (the production adapter only
   * ever requests version 1; this is how the blocked-upgrade path is tested).
   * Resolves with the first status; later changes arrive through the log.
   */
  async openLibrary(options: {version?: number} = {}): Promise<StatusSummary> {
    const first = await openAssetLibrary({
      ...(options.version === undefined
        ? {}
        : {indexedDB: versionedFactory(options.version)}),
      onStatusChange: applyStatus,
    });

    applyStatus(first);
    return summarizeStatus(first);
  },

  closeLibrary(): void {
    if (currentStatus?.kind === "ready") {
      currentStatus.store.close();
    }

    library = null;
  },

  statusLog: (): StatusSummary[] => [...statusLog],

  currentStatus: (): StatusSummary | null =>
    currentStatus === null ? null : summarizeStatus(currentStatus),

  waitForStatus(kind: string): Promise<void> {
    if (currentStatus?.kind === kind) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      statusWaiters.push({kind, resolve});
    });
  },

  /* ---- store operations (real library code over the real store) ---- */

  async seedImage(options: SeedOptions) {
    const {mutation, ref, digest} = await buildImportMutation(options);
    const lib = requireLibrary();
    // Stand-in for the import commit step: exclusive lock, apply, notify.
    const result = await withAssetLibraryLock(lib.locks, "exclusive", () =>
      lib.store.apply(mutation),
    );

    channel.post({
      type: "asset-library-changed",
      refs: [ref],
      digests: [digest],
    });

    return {result, ref, digest};
  },

  /** A transaction that throws after some writes were already queued. */
  async applyBrokenImport(options: SeedOptions) {
    const {mutation} = await buildImportMutation({
      ...options,
      nonCloneableBlob: true,
    });

    try {
      await requireLibrary().store.apply(mutation);
      return {ok: true as const};
    } catch (error) {
      return {ok: false as const, error: describeError(error)};
    }
  },

  async inspectRef(ref: LocalAssetRef) {
    const store = requireLibrary().store;
    const parsed = parseLocalAssetRef(ref);

    if (parsed === null) {
      throw new Error("not a ref");
    }

    const [row, meta, blob, thumbnail] = await Promise.all([
      store.getAssetRow(ref),
      store.getPayloadMeta(parsed.digest),
      store.getBlob(parsed.digest),
      store.getThumbnail(parsed.digest),
    ]);

    return {
      row,
      meta,
      blob:
        blob.status === "present"
          ? {
              status: "present" as const,
              size: blob.value.size,
              type: blob.value.type,
              sha256: await sha256Hex(
                new Uint8Array(await blob.value.arrayBuffer()),
              ),
            }
          : blob,
      thumbnail:
        thumbnail.status === "present"
          ? {
              status: "present" as const,
              mimeType: thumbnail.value.mimeType,
              blobType: thumbnail.value.blob.type,
              width: thumbnail.value.width,
              height: thumbnail.value.height,
              size: thumbnail.value.blob.size,
            }
          : thumbnail,
    };
  },

  async probeRead(ref: LocalAssetRef) {
    try {
      await requireLibrary().store.getAssetRow(ref);
      return {ok: true as const};
    } catch (error) {
      return {ok: false as const, error: describeError(error)};
    }
  },

  async rename(ref: LocalAssetRef, label: string) {
    return renameLocalAsset(requireLibrary(), ref, label);
  },

  async remove(ref: LocalAssetRef) {
    return deleteLocalAsset(requireLibrary(), ref);
  },

  /** Starts a rename without waiting for it (the exclusive lock may be busy). */
  startRename(ref: LocalAssetRef, label: string): void {
    pendingMutation = {state: "pending"};
    renameLocalAsset(requireLibrary(), ref, label).then(
      (result) => {
        pendingMutation = {state: "done", result};
      },
      (error) => {
        pendingMutation = {state: "failed", error: describeError(error)};
      },
    );
  },

  pendingMutation: (): unknown => pendingMutation,

  async listPage(category: LocalAssetCategory, cursor: AssetPageCursor = {}) {
    const page = await listLocalAssetPage(
      requireLibrary().store,
      category,
      cursor,
    );

    return {
      refs: page.entries.map((entry) => entry.ref),
      rowStatuses: page.entries.map((entry) => entry.row.status),
      hasPrevious: page.hasPrevious,
      hasNext: page.hasNext,
    };
  },

  async listStore(
    category: LocalAssetCategory,
    cursor: AssetPageCursor,
    limit: number,
  ) {
    const rows = await requireLibrary().store.listAssets(
      category,
      cursor,
      limit,
    );

    return rows.map(({ref, row}) => ({ref, status: row.status}));
  },

  count: (category: LocalAssetCategory) =>
    countLocalAssets(requireLibrary().store, category),

  /* ---- the real import pipeline (default decode + thumbnail) ---- */

  /**
   * Fetches a committed fixture from the dev server, wraps it in a `File` and
   * runs the REAL `importLocalAsset` (default createImageBitmap decode and
   * OffscreenCanvas thumbnail, no injected fakes) against the open library.
   */
  async importFixture(fixture: string, category: LocalAssetCategory) {
    const response = await fetch(`/tests/fixtures/local-assets/${fixture}`);

    if (!response.ok) {
      throw new Error(`Fixture ${fixture} answered ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const file = new File([bytes as BlobPart], fixture);
    const inspected = inspectImageBytes(bytes);

    if (!inspected.ok) {
      throw new Error(`Fixture ${fixture} rejected: ${inspected.reason}`);
    }

    const result = await importLocalAsset(file, category, requireLibrary());

    return {
      ref: result.ref,
      created: result.created,
      fixtureSha256: await sha256Hex(bytes),
      fixtureByteSize: bytes.length,
      header: inspected.image,
    };
  },

  async displayThumbnail(ref: LocalAssetRef) {
    const parsed = parseLocalAssetRef(ref);

    if (parsed === null) {
      throw new Error("not a ref");
    }

    const result = await loadThumbnailForDisplay(
      requireLibrary().store,
      parsed.digest,
    );

    return result.ok
      ? {ok: true as const, size: result.blob.size, type: result.blob.type}
      : {ok: false as const};
  },

  async verify(ref: LocalAssetRef) {
    const parsed = parseLocalAssetRef(ref);

    if (parsed === null) {
      throw new Error("not a ref");
    }

    const result = await verifyPayload(requireLibrary().store, parsed.digest);

    return result.ok
      ? {ok: true as const, payload: result.payload, blobType: result.blob.type}
      : {ok: false as const, reason: result.reason, detail: result.detail};
  },

  async renderCard(ref: LocalAssetRef) {
    const parsed = parseLocalAssetRef(ref);

    if (parsed === null) {
      throw new Error("not a ref");
    }

    const card = document.createElement("div");

    card.dataset.testid = "asset-card";
    card.dataset.ref = ref;
    document.querySelector("#harness-root")?.append(card);

    const thumbnail = await loadThumbnailForDisplay(
      requireLibrary().store,
      parsed.digest,
    );

    if (thumbnail.ok) {
      const image = document.createElement("img");

      image.src = URL.createObjectURL(thumbnail.blob);
      card.append(image);
      card.dataset.state = "image";
    } else {
      card.dataset.state = "neutral";
    }

    return card.dataset.state;
  },

  /* ---- raw IndexedDB access (separate short-lived connections) ---- */

  async rawSchema() {
    return withRawDatabase(async (database) => {
      const names = [...database.objectStoreNames];
      const transaction = database.transaction(names, "readonly");

      return {
        version: database.version,
        stores: names.map((name) => {
          const store = transaction.objectStore(name);

          return {
            name,
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            indexNames: [...store.indexNames],
          };
        }),
      };
    });
  },

  async rawKeys(storeName: StoreName): Promise<IDBValidKey[]> {
    return withRawDatabase((database) =>
      requestToPromise(
        database.transaction(storeName, "readonly").objectStore(storeName).getAllKeys(),
      ),
    );
  },

  async rawKeySnapshot(): Promise<Record<StoreName, IDBValidKey[]>> {
    const snapshot = {} as Record<StoreName, IDBValidKey[]>;

    for (const name of STORE_NAMES) {
      snapshot[name] = await toraHarness.rawKeys(name);
    }

    return snapshot;
  },

  async rawPut(
    storeName: StoreName,
    entries: Array<[string, unknown]>,
  ): Promise<void> {
    await withRawDatabase(async (database) => {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);

      for (const [key, value] of entries) {
        store.put(value, key);
      }

      await transactionDone(transaction);
    });
  },

  async databaseNames(): Promise<string[]> {
    return (await indexedDB.databases()).map((database) =>
      String(database.name),
    );
  },

  /** Opens `version` directly (as another tab with a newer app would) and closes it again. */
  async upgradeDatabaseTo(version: number): Promise<number> {
    const database = await rawOpen(version);
    const reached = database.version;

    database.close();
    return reached;
  },

  /** Holds a raw connection that never reacts to `versionchange`. */
  async holdStubbornConnection(): Promise<number> {
    heldRawConnection = await rawOpen();
    return heldRawConnection.version;
  },

  releaseStubbornConnection(): void {
    heldRawConnection?.close();
    heldRawConnection = null;
  },

  /* ---- web locks / channel ---- */

  holdLock(mode: "exclusive" | "shared"): Promise<void> {
    return new Promise((resolve) => {
      void withAssetLibraryLock(navigator.locks, mode, () => {
        resolve();
        return new Promise<void>((release) => {
          releaseHeldLock = release;
        });
      });
    });
  },

  releaseLock(): void {
    releaseHeldLock?.();
    releaseHeldLock = null;
  },

  async lockState() {
    const state = await navigator.locks.query();

    return {
      held: (state.held ?? [])
        .filter((lock) => lock.name === ASSET_LIBRARY_LOCK)
        .map((lock) => lock.mode),
      pending: (state.pending ?? [])
        .filter((lock) => lock.name === ASSET_LIBRARY_LOCK)
        .map((lock) => lock.mode),
    };
  },

  messages: (): AssetLibraryMessage[] => [...messages],

  /* ---- spies ---- */

  objectUrlCalls: () => [...objectUrlCalls],
  getAllCalls: () => [...getAllCalls],
};

let pendingMutation: unknown = null;

declare global {
  interface Window {
    toraHarness: typeof toraHarness;
  }
}

window.toraHarness = toraHarness;
