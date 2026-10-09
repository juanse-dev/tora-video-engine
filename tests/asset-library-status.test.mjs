import assert from "node:assert/strict";
import test from "node:test";

import {buildLocalAssetRef} from "../src/localAssets/refs.ts";
import {ASSET_LIBRARY_LOCK} from "../src/web/assetLibrary/constants.ts";
import {openAssetLibrary} from "../src/web/assetLibrary/coordination.ts";
import {
  openIndexedDbAssetStore,
  toLocalAssetLibraryError,
} from "../src/web/assetLibrary/indexedDbStore.ts";
import {LocalAssetLibraryError} from "../src/web/assetLibrary/store.ts";
import {createMemoryLockManager} from "./helpers/memoryAssetStore.mjs";

const BLOCKED_MESSAGE = "Close other Tora tabs to finish updating My assets.";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const succeed = (result) => {
  const request = {result, error: null, onsuccess: null, onerror: null};

  queueMicrotask(() => request.onsuccess?.());
  return request;
};

/** Fake database; `commit` decides how its read-write transactions end. */
const createFakeDatabase = (commit) => {
  const database = {
    version: 1,
    closed: false,
    onversionchange: null,
    onclose: null,
    objectStoreNames: {contains: () => true},
    close() {
      database.closed = true;
    },
    transaction() {
      if (database.closed) {
        throw new DOMException("The database connection is closing.", "InvalidStateError");
      }

      const transaction = {
        error: null,
        oncomplete: null,
        onabort: null,
        abort() {},
        objectStore: () => ({
          get: () => succeed(undefined),
          getKey: () => succeed(undefined),
          put: () => succeed(undefined),
          delete: () => succeed(undefined),
        }),
      };

      setTimeout(() => {
        if (commit === "complete") {
          transaction.oncomplete?.();
        } else {
          transaction.error = commit;
          transaction.onabort?.();
        }
      }, 0);

      return transaction;
    },
  };

  return database;
};

const createFakeFactory = () => {
  const requests = [];

  return {
    requests,
    open(name, version) {
      const request = {
        name,
        version,
        result: null,
        error: null,
        onupgradeneeded: null,
        onblocked: null,
        onsuccess: null,
        onerror: null,
      };

      requests.push(request);
      return request;
    },
  };
};

const importMutation = () => {
  const ref = buildLocalAssetRef("pose", "a".repeat(64));

  return {
    kind: "import",
    ref,
    defaultLabel: "Pose",
    originalFilename: "pose.png",
    createdAt: "2026-01-01T00:00:00.000Z",
    payloadMeta: {mimeType: "image/png", byteSize: 4, width: 1, height: 1},
    blob: new Blob([new Uint8Array([1, 2, 3, 4])]),
    thumbnail: {
      blob: new Blob([new Uint8Array([1])]),
      mimeType: "image/png",
      width: 1,
      height: 1,
    },
  };
};

test("without Web Locks the library is disabled and indexedDB.open is never called", async () => {
  const factory = createFakeFactory();

  for (const locks of [{}, {request: "nope"}]) {
    const status = await openAssetLibrary({locks, indexedDB: factory});

    assert.equal(status.kind, "disabled");
    assert.equal(
      status.message,
      "My assets needs a browser with Web Locks support. Local assets in this Story can't be shown or rendered here.",
    );
  }

  assert.equal(factory.requests.length, 0);
});

test("without indexedDB the library is unavailable", async () => {
  const status = await openAssetLibrary({locks: createMemoryLockManager()});

  assert.equal(status.kind, "unavailable");
  assert.match(status.message, /reload/i);
});

test("a failing open is unavailable and releases the lock", async () => {
  const locks = createMemoryLockManager();
  const factory = createFakeFactory();
  const opening = openAssetLibrary({locks, indexedDB: factory});

  await flush();
  assert.equal(locks.held(ASSET_LIBRARY_LOCK).exclusive, true);
  factory.requests[0].error = new DOMException("denied", "SecurityError");
  factory.requests[0].onerror();

  const status = await opening;

  assert.equal(status.kind, "unavailable");
  await flush();
  assert.equal(locks.held(ASSET_LIBRARY_LOCK).exclusive, false);
});

test("a database from a newer build is reported as unavailable", async () => {
  const factory = createFakeFactory();
  const opening = openAssetLibrary({
    locks: createMemoryLockManager(),
    indexedDB: factory,
  });

  await flush();
  factory.requests[0].error = new DOMException("too new", "VersionError");
  factory.requests[0].onerror();

  const status = await opening;

  assert.equal(status.kind, "unavailable");
  assert.match(status.message, /newer version/i);
});

test("a successful open creates only missing stores and releases the lock", async () => {
  const locks = createMemoryLockManager();
  const factory = createFakeFactory();
  const changes = [];
  const opening = openAssetLibrary({
    locks,
    indexedDB: factory,
    onStatusChange: (status) => changes.push(status),
  });

  await flush();

  const [request] = factory.requests;
  const existing = new Set(["assets"]);
  const created = [];

  assert.equal(request.name, "tora-video-engine-assets");
  assert.equal(request.version, 1);
  assert.equal(locks.held(ASSET_LIBRARY_LOCK).exclusive, true);
  request.result = {
    objectStoreNames: {contains: (name) => existing.has(name)},
    createObjectStore: (name) => created.push(name),
  };
  request.onupgradeneeded();
  assert.deepEqual(created, ["payloadMeta", "blobs", "thumbnails"]);

  request.result = createFakeDatabase("complete");
  request.onsuccess();

  const status = await opening;

  assert.equal(status.kind, "ready");
  assert.equal(typeof request.result.onversionchange, "function");
  assert.equal(typeof request.result.onclose, "function");
  assert.deepEqual(changes, []);
  await flush();
  assert.equal(locks.held(ASSET_LIBRARY_LOCK).exclusive, false);
});

test("a blocked open reports unavailable, keeps the lock, then becomes ready", async () => {
  const locks = createMemoryLockManager();
  const factory = createFakeFactory();
  const changes = [];
  const opening = openAssetLibrary({
    locks,
    indexedDB: factory,
    onStatusChange: (status) => changes.push(status),
  });

  await flush();

  const [request] = factory.requests;

  request.onblocked();

  const first = await opening;

  assert.deepEqual(first, {kind: "unavailable", message: BLOCKED_MESSAGE});
  assert.deepEqual(changes, [first]);
  await flush();
  assert.equal(locks.held(ASSET_LIBRARY_LOCK).exclusive, true);

  request.result = createFakeDatabase("complete");
  request.onsuccess();
  await flush();

  assert.equal(changes.length, 2);
  assert.equal(changes[1].kind, "ready");
  assert.equal(locks.held(ASSET_LIBRARY_LOCK).exclusive, false);
});

test("a blocked open that later fails stays unavailable and releases the lock", async () => {
  const locks = createMemoryLockManager();
  const factory = createFakeFactory();
  const changes = [];
  const opening = openAssetLibrary({
    locks,
    indexedDB: factory,
    onStatusChange: (status) => changes.push(status),
  });

  await flush();
  factory.requests[0].onblocked();
  await opening;
  factory.requests[0].error = new DOMException("aborted", "AbortError");
  factory.requests[0].onerror();
  await flush();

  assert.equal(changes.length, 2);
  assert.equal(changes[1].kind, "unavailable");
  assert.notEqual(changes[1].message, BLOCKED_MESSAGE);
  assert.equal(locks.held(ASSET_LIBRARY_LOCK).exclusive, false);
});

const openFakeStore = async (database) => {
  const locks = createMemoryLockManager();
  const factory = createFakeFactory();
  const opening = openIndexedDbAssetStore({indexedDB: factory, locks});

  await flush();
  factory.requests[0].result = database;
  factory.requests[0].onsuccess();
  return opening;
};

test("a transaction aborted with QuotaExceededError surfaces as storage-full", async () => {
  const store = await openFakeStore(
    createFakeDatabase(new DOMException("quota", "QuotaExceededError")),
  );

  await assert.rejects(store.apply(importMutation()), (error) => {
    assert.ok(error instanceof LocalAssetLibraryError);
    assert.equal(error.name, "LocalAssetLibraryError");
    assert.equal(error.code, "storage-full");
    return true;
  });
});

test("other transaction failures surface as storage-error", async () => {
  const store = await openFakeStore(
    createFakeDatabase(new DOMException("disk", "UnknownError")),
  );

  await assert.rejects(store.apply(importMutation()), (error) => {
    assert.ok(error instanceof LocalAssetLibraryError);
    assert.equal(error.name, "LocalAssetLibraryError");
    assert.equal(error.code, "storage-error");
    return true;
  });
});

test("error mapping keeps library errors and classifies by name", () => {
  const existing = new LocalAssetLibraryError("storage-error", "x");

  assert.equal(toLocalAssetLibraryError(existing), existing);
  assert.equal(
    toLocalAssetLibraryError(new DOMException("q", "QuotaExceededError")).code,
    "storage-full",
  );
  assert.equal(toLocalAssetLibraryError("weird").code, "storage-error");
  assert.equal(toLocalAssetLibraryError(null).code, "storage-error");
});

test("the connection handlers exist the moment the open request succeeds", async () => {
  const locks = createMemoryLockManager();
  const factory = createFakeFactory();
  const opening = openIndexedDbAssetStore({indexedDB: factory, locks});

  await flush();

  const database = createFakeDatabase("complete");

  factory.requests[0].result = database;
  factory.requests[0].onsuccess();
  // Nothing has been awaited yet: a versionchange event arriving right now
  // must already find both handlers.
  assert.equal(typeof database.onversionchange, "function");
  assert.equal(typeof database.onclose, "function");

  const store = await opening;

  database.onversionchange();
  await assert.rejects(store.countAssets("pose"), /upgraded in another tab.*reload/is);
});

test("an unexpected close makes later calls ask for a reload", async () => {
  const database = createFakeDatabase("complete");
  const store = await openFakeStore(database);

  database.onclose();
  await assert.rejects(store.countAssets("pose"), /closed unexpectedly.*reload/is);
});

test("versionchange closes the connection and later calls ask for a reload", async () => {
  const database = createFakeDatabase("complete");
  const store = await openFakeStore(database);

  database.onversionchange();
  assert.equal(database.closed, true);

  await assert.rejects(
    store.getAssetRow(buildLocalAssetRef("pose", "b".repeat(64))),
    /upgraded in another tab.*reload/is,
  );
  await assert.rejects(store.countAssets("pose"), /reload/i);
});

test("invalid mutations are rejected before any transaction starts", async () => {
  const database = createFakeDatabase("complete");
  let transactions = 0;
  const original = database.transaction;

  database.transaction = (...args) => {
    transactions += 1;
    return original(...args);
  };

  const store = await openFakeStore(database);

  await assert.rejects(store.apply({kind: "import", ref: "local:pose:sha256:x"}), /canonical/);
  await assert.rejects(
    store.apply({kind: "explode", ref: buildLocalAssetRef("pose", "c".repeat(64))}),
    /Unknown mutation kind/,
  );
  assert.equal(transactions, 0);
});
