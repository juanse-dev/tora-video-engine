import assert from "node:assert/strict";
import {test} from "node:test";
import {sha256Hex} from "../src/localAssets/hash.ts";
import {
  MAX_LOCAL_ASSET_BYTES,
  MAX_LOCAL_ASSET_DIMENSION,
} from "../src/localAssets/limits.ts";
import {buildLocalAssetRef} from "../src/localAssets/refs.ts";
import * as constants from "../src/web/assetLibrary/constants.ts";
import {
  createAssetLibraryChannel,
  requestPersistentStorageOnce,
  resetPersistentStorageRequestForTests,
  withAssetLibraryLock,
} from "../src/web/assetLibrary/coordination.ts";
import {
  countLocalAssets,
  deleteLocalAsset,
  listLocalAssetPage,
  loadThumbnailForDisplay,
  normalizeLocalAssetLabel,
  renameLocalAsset,
} from "../src/web/assetLibrary/library.ts";
import {
  commitPreparedLocalAssetImport,
  importLocalAsset,
  LocalAssetImportError,
  prepareLocalAssetImport,
} from "../src/web/assetLibrary/importAsset.ts";
import {
  decodeAssetRow,
  decodeBlobRecord,
  decodePayloadMeta,
  decodeThumbnail,
} from "../src/web/assetLibrary/records.ts";
import {fitWithin} from "../src/web/assetLibrary/thumbnails.ts";
import {
  buildJpeg,
  buildPng,
  buildWebpVp8,
} from "./helpers/imageBytes.mjs";
import {
  createMemoryAssetStore,
  createMemoryBroadcastChannelClass,
  createMemoryLockManager,
} from "./helpers/memoryAssetStore.mjs";

const digestOf = (n) => n.toString(16).padStart(64, "0");
const poseRef = (n) => buildLocalAssetRef("pose", digestOf(n));
const backgroundRef = (n) => buildLocalAssetRef("background", digestOf(n));
const DIGEST = digestOf(1);
const POSE = poseRef(1);
const BACKGROUND = backgroundRef(1);
const CREATED_AT = "2026-01-02T03:04:05.000Z";

const validRow = {label: "Hero", originalFilename: "hero.png", createdAt: CREATED_AT};
const validMeta = {mimeType: "image/png", byteSize: 100, width: 10, height: 20};
const validThumbnail = () => ({
  blob: new Blob([buildPng({width: 64, height: 32})], {type: "image/png"}),
  mimeType: "image/png",
  width: 64,
  height: 32,
});

const importMutation = (ref, overrides = {}) => ({
  kind: "import",
  ref,
  defaultLabel: "Hero",
  originalFilename: "hero.png",
  createdAt: CREATED_AT,
  payloadMeta: {...validMeta},
  blob: new Blob([new Uint8Array([1, 2, 3])], {type: "image/png"}),
  thumbnail: validThumbnail(),
  ...overrides,
});

const makeLibrary = (store = createMemoryAssetStore()) => {
  const locks = createMemoryLockManager();
  const posted = [];

  return {
    store,
    locks,
    posted,
    channel: {post: (message) => posted.push(message)},
  };
};

/* ------------------------------------------------------------ constants */

test("library constants match the README table", () => {
  assert.equal(constants.MAX_THUMBNAIL_DIMENSION, 256);
  assert.equal(constants.MAX_THUMBNAIL_BYTES, 512 * 1024);
  assert.equal(constants.LOCAL_ASSET_PAGE_SIZE, 50);
  assert.equal(constants.MAX_LOCAL_ASSET_LABEL_LENGTH, 80);
  assert.equal(constants.ASSET_DB_NAME, "tora-video-engine-assets");
  assert.equal(constants.ASSET_DB_VERSION, 1);
  assert.equal(constants.ASSET_LIBRARY_LOCK, "tora-video-engine:asset-library");
  assert.equal(
    constants.ASSET_LIBRARY_CHANNEL,
    "tora-video-engine:asset-library",
  );
});

/* -------------------------------------------------------------- decoders */

test("every decoder maps undefined to absent", () => {
  assert.deepEqual(decodeAssetRow(POSE, undefined), {status: "absent"});
  assert.deepEqual(decodePayloadMeta(DIGEST, undefined), {status: "absent"});
  assert.deepEqual(decodeBlobRecord(DIGEST, undefined), {status: "absent"});
  assert.deepEqual(decodeThumbnail(DIGEST, undefined), {status: "absent"});
});

test("decodeAssetRow accepts canonical rows and rejects wrong field types", () => {
  assert.deepEqual(decodeAssetRow(POSE, validRow), {
    status: "present",
    value: validRow,
  });

  for (const value of [
    null,
    "row",
    [],
    {label: 1, originalFilename: "a", createdAt: CREATED_AT},
    {label: "a", originalFilename: 2, createdAt: CREATED_AT},
    {label: "a", originalFilename: "a", createdAt: 3},
    {label: "a", originalFilename: "a"},
    {},
  ]) {
    assert.equal(decodeAssetRow(POSE, value).status, "corrupt", JSON.stringify(value));
  }
});

test("decodeAssetRow tolerates identity fields only when they equal what the key implies", () => {
  const matching = decodeAssetRow(POSE, {
    ...validRow,
    ref: POSE,
    category: "pose",
    digest: DIGEST,
  });

  assert.deepEqual(matching, {status: "present", value: validRow});

  for (const extra of [
    {digest: digestOf(2)},
    {ref: BACKGROUND},
    {ref: poseRef(2)},
    {category: "background"},
  ]) {
    assert.equal(
      decodeAssetRow(POSE, {...validRow, ...extra}).status,
      "corrupt",
      JSON.stringify(extra),
    );
  }
});

test("decodePayloadMeta enforces INV-7 on stored values", () => {
  assert.deepEqual(decodePayloadMeta(DIGEST, validMeta), {
    status: "present",
    value: validMeta,
  });
  assert.equal(
    decodePayloadMeta(DIGEST, {
      mimeType: "image/webp",
      byteSize: MAX_LOCAL_ASSET_BYTES,
      width: MAX_LOCAL_ASSET_DIMENSION,
      height: 6103,
    }).status,
    "present",
  );

  const bad = [
    {...validMeta, mimeType: "image/gif"},
    {...validMeta, mimeType: 7},
    {...validMeta, byteSize: 0},
    {...validMeta, byteSize: -1},
    {...validMeta, byteSize: 1.5},
    {...validMeta, byteSize: Number.NaN},
    {...validMeta, byteSize: Number.POSITIVE_INFINITY},
    {...validMeta, byteSize: "100"},
    {...validMeta, byteSize: MAX_LOCAL_ASSET_BYTES + 1},
    {...validMeta, width: 0},
    {...validMeta, width: 10.5},
    {...validMeta, width: MAX_LOCAL_ASSET_DIMENSION + 1},
    {...validMeta, height: MAX_LOCAL_ASSET_DIMENSION + 1},
    {...validMeta, width: 8192, height: 6104}, // 50_003_968 pixels
    {mimeType: "image/png", byteSize: 1, width: 1},
    null,
    "meta",
  ];

  for (const value of bad) {
    assert.equal(decodePayloadMeta(DIGEST, value).status, "corrupt", JSON.stringify(value));
  }
});

test("decodePayloadMeta, decodeBlobRecord and decodeThumbnail reject identity fields that disagree with the key", () => {
  const blob = new Blob([new Uint8Array([1])]);

  for (const extra of [
    {digest: digestOf(2)},
    {ref: poseRef(2)},
    {ref: "not a ref"},
    {category: "pose"},
  ]) {
    assert.equal(decodePayloadMeta(DIGEST, {...validMeta, ...extra}).status, "corrupt");
    assert.equal(decodeBlobRecord(DIGEST, {blob, ...extra}).status, "corrupt");
    assert.equal(
      decodeThumbnail(DIGEST, {...validThumbnail(), ...extra}).status,
      "corrupt",
    );
  }

  assert.equal(
    decodePayloadMeta(DIGEST, {...validMeta, digest: DIGEST, ref: POSE}).status,
    "present",
  );
  assert.equal(decodePayloadMeta("ABC", validMeta).status, "corrupt");
});

test("decodeBlobRecord requires a non-empty Blob", () => {
  const blob = new Blob([new Uint8Array([1, 2])]);

  assert.deepEqual(decodeBlobRecord(DIGEST, {blob}), {status: "present", value: blob});

  for (const value of [
    {},
    {blob: "bytes"},
    {blob: new Uint8Array([1])},
    {blob: new Blob([])},
    null,
    blob,
  ]) {
    assert.equal(decodeBlobRecord(DIGEST, value).status, "corrupt");
  }
});

test("decodeThumbnail bounds dimensions and size on read", () => {
  const thumb = validThumbnail();

  assert.equal(decodeThumbnail(DIGEST, thumb).status, "present");
  assert.equal(
    decodeThumbnail(DIGEST, {...thumb, width: 256, height: 256}).status,
    "present",
  );

  const bad = [
    {...thumb, width: 257},
    {...thumb, height: 257},
    {...thumb, width: 0},
    {...thumb, width: 1.5},
    {...thumb, height: Number.NaN},
    {...thumb, mimeType: "image/gif"},
    {...thumb, mimeType: undefined},
    {...thumb, blob: "bytes"},
    {...thumb, blob: new Blob([])},
    {...thumb, blob: new Blob([new Uint8Array(512 * 1024 + 1)])},
  ];

  for (const value of bad) {
    assert.equal(decodeThumbnail(DIGEST, value).status, "corrupt");
  }

  assert.equal(
    decodeThumbnail(DIGEST, {
      ...thumb,
      blob: new Blob([new Uint8Array(512 * 1024)]),
    }).status,
    "present",
  );
});

/* ------------------------------------------------------------ labels */

test("normalizeLocalAssetLabel trims and bounds labels by code points", () => {
  assert.deepEqual(normalizeLocalAssetLabel("  Hero  "), {ok: true, label: "Hero"});
  assert.equal(normalizeLocalAssetLabel("").ok, false);
  assert.equal(normalizeLocalAssetLabel("   \n\t ").ok, false);
  assert.equal(normalizeLocalAssetLabel("a".repeat(80)).ok, true);
  assert.equal(normalizeLocalAssetLabel("a".repeat(81)).ok, false);
  // Emoji are single code points but two UTF-16 units.
  assert.equal(normalizeLocalAssetLabel("😀".repeat(80)).ok, true);
  assert.equal(normalizeLocalAssetLabel("😀".repeat(81)).ok, false);
  // Whitespace padding does not count.
  assert.equal(normalizeLocalAssetLabel(` ${"a".repeat(80)} `).ok, true);

  const rejected = normalizeLocalAssetLabel("");

  assert.equal(typeof rejected.message, "string");
  assert.ok(rejected.message.length > 0);
});

/* ------------------------------------------------- store: import semantics */

test("import creates the row and backing records", async () => {
  const store = createMemoryAssetStore();
  const mutation = importMutation(POSE);
  const result = await store.apply(mutation);

  assert.deepEqual(result, {kind: "imported", ref: POSE, created: true});
  assert.deepEqual(await store.getAssetRow(POSE), {
    status: "present",
    value: validRow,
  });
  assert.deepEqual(await store.getPayloadMeta(DIGEST), {
    status: "present",
    value: validMeta,
  });
  assert.equal((await store.getBlob(DIGEST)).status, "present");
  assert.equal((await store.getThumbnail(DIGEST)).status, "present");
  // The key is the identity: new writes carry no identity fields.
  assert.deepEqual(Object.keys(store.getRaw("assets", POSE)).sort(), [
    "createdAt",
    "label",
    "originalFilename",
  ]);
  assert.deepEqual(Object.keys(store.getRaw("payloadMeta", DIGEST)).sort(), [
    "byteSize",
    "height",
    "mimeType",
    "width",
  ]);
  assert.deepEqual(Object.keys(store.getRaw("blobs", DIGEST)), ["blob"]);
});

test("re-importing the same bytes keeps label/createdAt, refreshes the filename and repairs backing data", async () => {
  const store = createMemoryAssetStore();

  await store.apply(importMutation(POSE));
  await store.apply({kind: "rename", ref: POSE, label: "Renamed"});
  store.deleteRaw("blobs", DIGEST);
  store.deleteRaw("thumbnails", DIGEST);
  store.setRaw("payloadMeta", DIGEST, {mimeType: "image/png", byteSize: -5});
  assert.equal((await store.getBlob(DIGEST)).status, "absent");

  const freshBlob = new Blob([new Uint8Array([9, 9, 9, 9])]);
  const result = await store.apply(
    importMutation(POSE, {
      defaultLabel: "Fresh default",
      originalFilename: "again.png",
      createdAt: "2030-01-01T00:00:00.000Z",
      blob: freshBlob,
    }),
  );

  assert.deepEqual(result, {kind: "imported", ref: POSE, created: false});
  assert.deepEqual(await store.getAssetRow(POSE), {
    status: "present",
    value: {
      label: "Renamed",
      originalFilename: "again.png",
      createdAt: CREATED_AT,
    },
  });
  assert.deepEqual(await store.getBlob(DIGEST), {status: "present", value: freshBlob});
  assert.equal((await store.getThumbnail(DIGEST)).status, "present");
  assert.deepEqual(await store.getPayloadMeta(DIGEST), {
    status: "present",
    value: validMeta,
  });
});

test("an import reads the existing row inside apply, so a concurrent rename is preserved", async () => {
  const store = createMemoryAssetStore();

  await store.apply(importMutation(POSE));
  // The mutation was built (defaultLabel captured) before this rename landed.
  const staleMutation = importMutation(POSE, {defaultLabel: "Stale default"});

  await store.apply({kind: "rename", ref: POSE, label: "Renamed in other tab"});
  await store.apply(staleMutation);

  assert.equal((await store.getAssetRow(POSE)).value.label, "Renamed in other tab");
});

test("same bytes in the other category adds a second row and a single payload", async () => {
  const store = createMemoryAssetStore();

  await store.apply(importMutation(POSE));
  const result = await store.apply(importMutation(BACKGROUND));

  assert.deepEqual(result, {kind: "imported", ref: BACKGROUND, created: true});
  assert.equal((await store.getAssetRow(POSE)).status, "present");
  assert.equal((await store.getAssetRow(BACKGROUND)).status, "present");
  assert.deepEqual(store.keys("payloadMeta"), [DIGEST]);
  assert.deepEqual(store.keys("blobs"), [DIGEST]);
  assert.deepEqual(store.keys("thumbnails"), [DIGEST]);
});

test("importing over a corrupt row rewrites it canonically", async () => {
  for (const corrupt of [{label: 1}, {digest: digestOf(2), ...validRow}]) {
    const store = createMemoryAssetStore();

    store.setRaw("assets", POSE, corrupt);
    assert.equal((await store.getAssetRow(POSE)).status, "corrupt");

    const result = await store.apply(
      importMutation(POSE, {defaultLabel: "Repaired", originalFilename: "r.png"}),
    );

    assert.deepEqual(result, {kind: "imported", ref: POSE, created: false});
    assert.deepEqual(await store.getAssetRow(POSE), {
      status: "present",
      value: {label: "Repaired", originalFilename: "r.png", createdAt: CREATED_AT},
    });
    assert.deepEqual(Object.keys(store.getRaw("assets", POSE)).sort(), [
      "createdAt",
      "label",
      "originalFilename",
    ]);
  }
});

/* ------------------------------------------------ store: rename / delete */

test("rename changes only the label and never recreates a deleted row", async () => {
  const store = createMemoryAssetStore();

  await store.apply(importMutation(POSE));

  assert.deepEqual(await store.apply({kind: "rename", ref: POSE, label: "New"}), {
    kind: "renamed",
    ref: POSE,
  });
  assert.deepEqual((await store.getAssetRow(POSE)).value, {
    ...validRow,
    label: "New",
  });

  await store.apply({kind: "delete", ref: POSE});

  const before = store.snapshot();

  assert.deepEqual(await store.apply({kind: "rename", ref: POSE, label: "Ghost"}), {
    kind: "not-found",
    ref: POSE,
  });
  assert.deepEqual(store.snapshot(), before);
  assert.equal((await store.getAssetRow(POSE)).status, "absent");
});

test("rename of a corrupt row rewrites it with an empty filename and a fresh createdAt", async () => {
  const store = createMemoryAssetStore();

  store.setRaw("assets", POSE, {label: 5});

  const startedAt = Date.now();

  assert.equal(
    (await store.apply({kind: "rename", ref: POSE, label: "Fixed"})).kind,
    "renamed",
  );

  const row = (await store.getAssetRow(POSE)).value;

  assert.equal(row.label, "Fixed");
  assert.equal(row.originalFilename, "");
  assert.ok(Date.parse(row.createdAt) >= startedAt - 1000);
});

test("delete keeps the payload while the other category still references it", async () => {
  const store = createMemoryAssetStore();

  await store.apply(importMutation(POSE));
  await store.apply(importMutation(BACKGROUND));

  assert.deepEqual(await store.apply({kind: "delete", ref: POSE}), {
    kind: "deleted",
    ref: POSE,
    payloadRemoved: false,
  });
  assert.equal((await store.getAssetRow(POSE)).status, "absent");
  assert.equal((await store.getAssetRow(BACKGROUND)).status, "present");
  assert.equal((await store.getPayloadMeta(DIGEST)).status, "present");
  assert.equal((await store.getBlob(DIGEST)).status, "present");
  assert.equal((await store.getThumbnail(DIGEST)).status, "present");

  assert.deepEqual(await store.apply({kind: "delete", ref: BACKGROUND}), {
    kind: "deleted",
    ref: BACKGROUND,
    payloadRemoved: true,
  });
  assert.equal((await store.getPayloadMeta(DIGEST)).status, "absent");
  assert.equal((await store.getBlob(DIGEST)).status, "absent");
  assert.equal((await store.getThumbnail(DIGEST)).status, "absent");
});

test("delete of a missing row is not-found and leaves everything alone", async () => {
  const store = createMemoryAssetStore();

  await store.apply(importMutation(POSE));

  const before = store.snapshot();

  assert.deepEqual(await store.apply({kind: "delete", ref: BACKGROUND}), {
    kind: "not-found",
    ref: BACKGROUND,
  });
  assert.deepEqual(store.snapshot(), before);
});

test("delete derives the GC digest from the key even when the row claims another digest", async () => {
  const store = createMemoryAssetStore();
  const otherDigest = digestOf(2);

  await store.apply(importMutation(POSE));
  await store.apply(importMutation(poseRef(2)));
  // The row at POSE lies about its digest (corrupt); deletion must still GC DIGEST only.
  store.setRaw("assets", POSE, {...validRow, digest: otherDigest});

  const result = await store.apply({kind: "delete", ref: POSE});

  assert.deepEqual(result, {kind: "deleted", ref: POSE, payloadRemoved: true});
  assert.equal((await store.getPayloadMeta(DIGEST)).status, "absent");
  assert.equal((await store.getPayloadMeta(otherDigest)).status, "present");
  assert.equal((await store.getBlob(otherDigest)).status, "present");
  assert.equal((await store.getAssetRow(poseRef(2))).status, "present");
});

test("a corrupt row in the other category still protects the shared payload", async () => {
  const store = createMemoryAssetStore();

  await store.apply(importMutation(POSE));
  store.setRaw("assets", BACKGROUND, {label: 1});

  const result = await store.apply({kind: "delete", ref: POSE});

  assert.equal(result.payloadRemoved, false);
  assert.equal((await store.getPayloadMeta(DIGEST)).status, "present");
});

test("a quota failure in apply leaves every store unchanged", async () => {
  const store = createMemoryAssetStore();

  await store.apply(importMutation(POSE));

  const before = store.snapshot();

  store.failNextApply();

  await assert.rejects(
    () => store.apply(importMutation(BACKGROUND)),
    (error) => error.name === "QuotaExceededError",
  );
  assert.deepEqual(store.snapshot(), before);

  // The injected failure is one-shot.
  assert.equal((await store.apply(importMutation(BACKGROUND))).created, true);

  const custom = new Error("boom");

  store.failNextApply(custom);
  await assert.rejects(() => store.apply({kind: "delete", ref: BACKGROUND}), custom);
  assert.equal((await store.getAssetRow(BACKGROUND)).status, "present");
});

test("the fake counts reads per store and supports raw injection", async () => {
  const store = createMemoryAssetStore();

  await store.apply(importMutation(POSE));
  assert.deepEqual(store.reads, {assets: 0, payloadMeta: 0, blobs: 0, thumbnails: 0});

  await store.getAssetRow(POSE);
  await store.getPayloadMeta(DIGEST);
  await store.getPayloadMeta(DIGEST);
  await store.getBlob(DIGEST);
  await store.getThumbnail(DIGEST);
  assert.deepEqual(store.reads, {assets: 1, payloadMeta: 2, blobs: 1, thumbnails: 1});

  store.resetReads();
  assert.deepEqual(store.reads, {assets: 0, payloadMeta: 0, blobs: 0, thumbnails: 0});

  store.setRaw("payloadMeta", DIGEST, {mimeType: "image/png"});
  assert.equal((await store.getPayloadMeta(DIGEST)).status, "corrupt");
  store.setRaw("blobs", DIGEST, "not a record");
  assert.equal((await store.getBlob(DIGEST)).status, "corrupt");
});

/* ---------------------------------------------------------------- paging */

const seedPaging = async () => {
  const store = createMemoryAssetStore();

  for (let n = 1; n <= 120; n += 1) {
    store.setRaw("assets", poseRef(n), {...validRow, label: `Pose ${n}`});
  }

  for (let n = 1; n <= 3; n += 1) {
    store.setRaw("assets", backgroundRef(n), {...validRow, label: `Background ${n}`});
  }

  // Non-canonical keys inside the pose prefix: uppercase digest and a short digest.
  store.setRaw("assets", `local:pose:sha256:${digestOf(0xabc).toUpperCase()}`, validRow);
  store.setRaw("assets", `local:pose:sha256:${digestOf(5).slice(-10)}`, validRow);

  return store;
};

const labels = (page) => page.entries.map((entry) => entry.row.value.label);
const expectPoses = (page, from, to) =>
  assert.deepEqual(
    labels(page),
    Array.from({length: to - from + 1}, (_, index) => `Pose ${from + index}`),
  );

test("paging returns canonical rows in key order and skips non-canonical keys", async () => {
  const store = await seedPaging();

  assert.equal(store.keys("assets").length, 125);

  const first = await listLocalAssetPage(store, "pose", {});

  assert.equal(first.entries.length, 50);
  assert.equal(first.hasNext, true);
  assert.equal(first.hasPrevious, false);
  expectPoses(first, 1, 50);
  assert.ok(first.entries.every((entry) => entry.category === "pose"));
  assert.ok(first.entries.every((entry) => entry.ref === poseRef(Number.parseInt(entry.digest, 16))));
  assert.ok(first.entries.every((entry) => /^[0-9a-f]{64}$/u.test(entry.digest)));

  const second = await listLocalAssetPage(store, "pose", {
    after: first.entries[49].ref,
  });

  expectPoses(second, 51, 100);
  assert.equal(second.hasPrevious, true);
  assert.equal(second.hasNext, true);

  const third = await listLocalAssetPage(store, "pose", {
    after: second.entries[49].ref,
  });

  expectPoses(third, 101, 120);
  assert.equal(third.hasPrevious, true);
  assert.equal(third.hasNext, false);

  const backToSecond = await listLocalAssetPage(store, "pose", {
    before: third.entries[0].ref,
  });

  expectPoses(backToSecond, 51, 100);
  assert.equal(backToSecond.hasPrevious, true);
  assert.equal(backToSecond.hasNext, true);

  const backToFirst = await listLocalAssetPage(store, "pose", {
    before: backToSecond.entries[0].ref,
  });

  expectPoses(backToFirst, 1, 50);
  assert.equal(backToFirst.hasPrevious, false);
  assert.equal(backToFirst.hasNext, true);

  const backgrounds = await listLocalAssetPage(store, "background", {});

  assert.deepEqual(labels(backgrounds), ["Background 1", "Background 2", "Background 3"]);
  assert.equal(backgrounds.hasNext, false);
  assert.equal(backgrounds.hasPrevious, false);
});

test("a page of exactly 50 rows has no next page", async () => {
  const store = createMemoryAssetStore();

  for (let n = 1; n <= 50; n += 1) {
    store.setRaw("assets", poseRef(n), validRow);
  }

  const page = await listLocalAssetPage(store, "pose", {});

  assert.equal(page.entries.length, 50);
  assert.equal(page.hasNext, false);
  assert.equal(page.hasPrevious, false);
});

test("paging never reads more than limit + 1 rows and counting does not list", async () => {
  const store = await seedPaging();

  store.resetReads();
  await listLocalAssetPage(store, "pose", {});
  assert.equal(store.reads.assets, 51);
  assert.equal(store.reads.blobs, 0);
  assert.equal(store.reads.payloadMeta, 0);
  assert.equal(store.reads.thumbnails, 0);

  store.resetReads();
  await listLocalAssetPage(store, "pose", {before: poseRef(120)});
  assert.equal(store.reads.assets, 51);

  store.resetReads();
  assert.equal(await store.countAssets("pose"), 120);
  assert.equal(await countLocalAssets(store, "pose"), 120);
  assert.equal(await countLocalAssets(store, "background"), 3);
  assert.deepEqual(store.reads, {assets: 0, payloadMeta: 0, blobs: 0, thumbnails: 0});
});

test("corrupt rows are listed so they can be repaired or deleted", async () => {
  const store = createMemoryAssetStore();

  store.setRaw("assets", poseRef(1), validRow);
  store.setRaw("assets", poseRef(2), {label: 1});

  const page = await listLocalAssetPage(store, "pose", {});

  assert.equal(page.entries.length, 2);
  assert.equal(page.entries[0].row.status, "present");
  assert.equal(page.entries[1].row.status, "corrupt");
  assert.equal(page.entries[1].digest, digestOf(2));
});

/* ----------------------------------------------- library: rename / delete */

test("renameLocalAsset locks exclusively, normalizes the label and announces the change", async () => {
  const library = makeLibrary();

  await library.store.apply(importMutation(POSE));

  const result = await renameLocalAsset(library, POSE, "  Fresh  ");

  assert.deepEqual(result, {kind: "renamed", ref: POSE});
  assert.equal((await library.store.getAssetRow(POSE)).value.label, "Fresh");
  assert.deepEqual(
    library.locks.requests.map(({name, mode}) => ({name, mode})),
    [{name: constants.ASSET_LIBRARY_LOCK, mode: "exclusive"}],
  );
  assert.deepEqual(library.posted, [
    {type: "asset-library-changed", refs: [POSE], digests: [DIGEST]},
  ]);
});

test("renameLocalAsset rejects invalid labels without touching the store or the lock", async () => {
  const library = makeLibrary();

  await library.store.apply(importMutation(POSE));
  library.store.applyCalls.length = 0;

  for (const label of ["", "   ", "a".repeat(81)]) {
    await assert.rejects(() => renameLocalAsset(library, POSE, label));
  }

  assert.equal(library.store.applyCalls.length, 0);
  assert.equal(library.locks.requests.length, 0);
  assert.equal(library.posted.length, 0);
});

test("rename and delete of a missing row return not-found and post nothing", async () => {
  const library = makeLibrary();

  assert.deepEqual(await renameLocalAsset(library, POSE, "Name"), {
    kind: "not-found",
    ref: POSE,
  });
  assert.deepEqual(await deleteLocalAsset(library, POSE), {
    kind: "not-found",
    ref: POSE,
  });
  assert.equal(library.posted.length, 0);
  assert.equal((await library.store.getAssetRow(POSE)).status, "absent");
});

test("deleteLocalAsset garbage-collects through the store and announces ref and digest", async () => {
  const library = makeLibrary();

  await library.store.apply(importMutation(POSE));
  await library.store.apply(importMutation(BACKGROUND));

  assert.deepEqual(await deleteLocalAsset(library, POSE), {
    kind: "deleted",
    ref: POSE,
    payloadRemoved: false,
  });
  assert.deepEqual(await deleteLocalAsset(library, BACKGROUND), {
    kind: "deleted",
    ref: BACKGROUND,
    payloadRemoved: true,
  });
  assert.deepEqual(library.posted, [
    {type: "asset-library-changed", refs: [POSE], digests: [DIGEST]},
    {type: "asset-library-changed", refs: [BACKGROUND], digests: [DIGEST]},
  ]);
  assert.equal(library.locks.requests.every((request) => request.mode === "exclusive"), true);
  assert.deepEqual(library.locks.held(constants.ASSET_LIBRARY_LOCK), {
    exclusive: false,
    shared: 0,
  });
});

test("a failed mutation posts nothing and releases the lock", async () => {
  const library = makeLibrary();

  await library.store.apply(importMutation(POSE));
  library.store.failNextApply();

  await assert.rejects(
    () => deleteLocalAsset(library, POSE),
    (error) => error.name === "QuotaExceededError",
  );
  assert.equal(library.posted.length, 0);
  assert.equal((await library.store.getAssetRow(POSE)).status, "present");
  assert.deepEqual(library.locks.held(constants.ASSET_LIBRARY_LOCK), {
    exclusive: false,
    shared: 0,
  });
});

test("a throwing channel does not fail a successful mutation", async () => {
  const library = makeLibrary();

  await library.store.apply(importMutation(POSE));
  library.channel.post = () => {
    throw new Error("channel closed");
  };

  assert.equal((await renameLocalAsset(library, POSE, "Ok")).kind, "renamed");
});

/* ------------------------------------------------ thumbnail verification */

const storeWithThumbnail = (bytes, record = {}) => {
  const store = createMemoryAssetStore();

  store.setRaw("thumbnails", DIGEST, {
    blob: new Blob([bytes]),
    mimeType: "image/png",
    width: 64,
    height: 32,
    ...record,
  });

  return store;
};

test("loadThumbnailForDisplay accepts a PNG or WebP whose real bytes match the record", async () => {
  const png = storeWithThumbnail(buildPng({width: 64, height: 32}));
  const result = await loadThumbnailForDisplay(png, DIGEST);

  assert.equal(result.ok, true);
  assert.ok(result.blob instanceof Blob);

  const webp = storeWithThumbnail(buildWebpVp8({width: 256, height: 200}), {
    mimeType: "image/webp",
    width: 256,
    height: 200,
  });

  assert.equal((await loadThumbnailForDisplay(webp, DIGEST)).ok, true);
  assert.equal(webp.reads.thumbnails, 1);
});

test("loadThumbnailForDisplay rejects thumbnails whose real bytes disagree with their record", async () => {
  const cases = {
    "real dimensions larger than 256 while the record claims small":
      storeWithThumbnail(buildPng({width: 4000, height: 4000})),
    "real dimensions differ from the record": storeWithThumbnail(
      buildPng({width: 64, height: 33}),
    ),
    "swapped dimensions": storeWithThumbnail(buildPng({width: 32, height: 64})),
    "real format is JPEG": storeWithThumbnail(buildJpeg({width: 64, height: 32})),
    "not an image": storeWithThumbnail(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    "truncated header": storeWithThumbnail(buildPng({width: 64, height: 32}).slice(0, 12)),
    "record out of bounds": storeWithThumbnail(buildPng({width: 300, height: 32}), {
      width: 300,
    }),
    "record missing": createMemoryAssetStore(),
  };

  for (const [name, store] of Object.entries(cases)) {
    assert.deepEqual(await loadThumbnailForDisplay(store, DIGEST), {ok: false}, name);
  }
});

/* ---------------------------------------------------------- coordination */

test("withAssetLibraryLock requests the asset library lock in the given mode", async () => {
  const locks = createMemoryLockManager();

  assert.equal(await withAssetLibraryLock(locks, "shared", async () => "value"), "value");
  assert.deepEqual(
    locks.requests.map(({name, mode}) => ({name, mode})),
    [{name: "tora-video-engine:asset-library", mode: "shared"}],
  );
});

test("exclusive tasks run one at a time and shared tasks overlap", async () => {
  const locks = createMemoryLockManager();
  const events = [];
  const gate = () => {
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });

    return {promise, release};
  };
  const first = gate();
  const firstDone = withAssetLibraryLock(locks, "exclusive", async () => {
    events.push("first:start");
    await first.promise;
    events.push("first:end");
  });
  const secondDone = withAssetLibraryLock(locks, "exclusive", async () => {
    events.push("second:start");
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(events, ["first:start"]);
  first.release();
  await Promise.all([firstDone, secondDone]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);

  const overlap = [];
  const sharedGate = gate();
  const shared = [1, 2].map((id) =>
    withAssetLibraryLock(locks, "shared", async () => {
      overlap.push(`start:${id}`);
      await sharedGate.promise;
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(overlap, ["start:1", "start:2"]);
  sharedGate.release();
  await Promise.all(shared);
});

test("withAssetLibraryLock forwards the signal and propagates task errors", async () => {
  const locks = createMemoryLockManager();
  let release;
  const holder = withAssetLibraryLock(
    locks,
    "exclusive",
    () => new Promise((resolve) => {
      release = resolve;
    }),
  );
  const controller = new AbortController();
  let ran = false;
  const waiting = withAssetLibraryLock(
    locks,
    "exclusive",
    async () => {
      ran = true;
    },
    {signal: controller.signal},
  );

  controller.abort();
  await assert.rejects(waiting, (error) => error.name === "AbortError");
  release();
  await holder;
  assert.equal(ran, false);

  await assert.rejects(
    () =>
      withAssetLibraryLock(locks, "exclusive", async () => {
        throw new Error("task failed");
      }),
    /task failed/u,
  );
  assert.deepEqual(locks.held("tora-video-engine:asset-library"), {
    exclusive: false,
    shared: 0,
  });
});

test("the asset library channel delivers messages to other channels and ignores malformed ones", async () => {
  const MemoryBroadcastChannel = createMemoryBroadcastChannelClass();
  const received = [];
  const receiver = createAssetLibraryChannel((message) => received.push(message), {
    BroadcastChannel: MemoryBroadcastChannel,
  });
  const sender = createAssetLibraryChannel(() => {}, {
    BroadcastChannel: MemoryBroadcastChannel,
  });
  const message = {type: "asset-library-changed", refs: [POSE], digests: [DIGEST]};

  sender.post(message);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(received, [message]);

  // Malformed payloads from another tab are dropped; junk entries are filtered.
  const raw = new MemoryBroadcastChannel("tora-video-engine:asset-library");

  raw.postMessage("hello");
  raw.postMessage({type: "other", refs: [], digests: []});
  raw.postMessage({type: "asset-library-changed", refs: "x", digests: []});
  raw.postMessage({
    type: "asset-library-changed",
    refs: [POSE, "local:pose:sha256:short", 5],
    digests: [DIGEST, "nope", null],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(received.length, 2);
  assert.deepEqual(received[1], message);

  receiver.close();
  sender.post(message);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(received.length, 2);
  sender.close();
  assert.doesNotThrow(() => sender.post(message));
});

test("the asset library channel works with the Node BroadcastChannel and without any", async () => {
  const received = [];
  const receiver = createAssetLibraryChannel((message) => received.push(message), {
    BroadcastChannel,
  });
  const sender = createAssetLibraryChannel(() => {}, {BroadcastChannel});
  const message = {type: "asset-library-changed", refs: [BACKGROUND], digests: [DIGEST]};

  sender.post(message);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(received, [message]);
  receiver.close();
  sender.close();

  const original = globalThis.BroadcastChannel;

  try {
    delete globalThis.BroadcastChannel;

    const none = createAssetLibraryChannel(() => {});

    assert.doesNotThrow(() => none.post(message));
    assert.doesNotThrow(() => none.close());
  } finally {
    globalThis.BroadcastChannel = original;
  }
});

test("sha256Hex digests produce canonical refs for the library", async () => {
  const digest = await sha256Hex(new Uint8Array([1, 2, 3]));
  const ref = buildLocalAssetRef("pose", digest);
  const store = createMemoryAssetStore();

  await store.apply(importMutation(ref));
  assert.equal((await store.getAssetRow(ref)).status, "present");
  assert.equal((await store.getPayloadMeta(digest)).status, "present");
});


/* ------------------------------------------------------ import pipeline */

const makeFile = (bytes, name = "hero.png") => {
  const file = new File([bytes], name);
  const calls = {arrayBuffer: 0};
  const original = file.arrayBuffer.bind(file);

  file.arrayBuffer = () => {
    calls.arrayBuffer += 1;
    return original();
  };

  return {file, calls};
};

const makeDeps = (overrides = {}) => {
  const log = {decode: [], thumbnail: [], closed: 0, phases: []};
  const deps = {
    decode: async (blob) => {
      log.decode.push(blob);
      return {
        width: overrides.decodedWidth ?? 10,
        height: overrides.decodedHeight ?? 20,
        close() {
          log.closed += 1;
        },
      };
    },
    makeThumbnail: async (blob, width, height) => {
      log.thumbnail.push({blob, width, height});
      return validThumbnail();
    },
    onPhase: (phase) => log.phases.push(phase),
    ...overrides.deps,
  };

  return {deps, log};
};

const PNG_10x20 = buildPng({width: 10, height: 20});

const rejectsWithCode = (promise, code) =>
  assert.rejects(
    promise,
    (error) => error instanceof LocalAssetImportError && error.code === code,
  );

test("prepare rejects oversized and empty files without reading their bytes", async () => {
  const {deps, log} = makeDeps();
  const big = makeFile(new Uint8Array(4));

  Object.defineProperty(big.file, "size", {value: MAX_LOCAL_ASSET_BYTES + 1});
  await rejectsWithCode(prepareLocalAssetImport(big.file, "pose", deps), "too-large");
  assert.equal(big.calls.arrayBuffer, 0);

  const empty = makeFile(new Uint8Array(0));

  await rejectsWithCode(prepareLocalAssetImport(empty.file, "pose", deps), "empty");
  assert.equal(empty.calls.arrayBuffer, 0);
  assert.deepEqual(log.phases, []);
  assert.equal(log.decode.length, 0);
});

test("prepare reports phases in order and builds the prepared import", async () => {
  const {deps, log} = makeDeps();
  const {file, calls} = makeFile(PNG_10x20, "IMG_0421.png");
  const prepared = await prepareLocalAssetImport(file, "pose", deps);
  const digest = await sha256Hex(PNG_10x20);

  assert.deepEqual(log.phases, ["reading", "validating", "hashing"]);
  assert.equal(calls.arrayBuffer, 1);
  assert.equal(prepared.ref, buildLocalAssetRef("pose", digest));
  assert.equal(prepared.defaultLabel, "IMG_0421");
  assert.equal(prepared.originalFilename, "IMG_0421.png");
  assert.deepEqual(prepared.payloadMeta, {
    mimeType: "image/png",
    byteSize: PNG_10x20.length,
    width: 10,
    height: 20,
  });
  assert.equal(prepared.blob.type, "image/png");
  assert.deepEqual(new Uint8Array(await prepared.blob.arrayBuffer()), PNG_10x20);
  assert.equal(prepared.thumbnail.mimeType, "image/png");
  // Decode and thumbnail both work on the original bytes, with the header size.
  assert.equal(log.decode.length, 1);
  assert.equal(log.decode[0], prepared.blob);
  assert.equal(log.thumbnail.length, 1);
  assert.equal(log.thumbnail[0].blob, prepared.blob);
  assert.equal(log.thumbnail[0].width, 10);
  assert.equal(log.thumbnail[0].height, 20);
  assert.equal(log.closed, 1);
});

test("prepare uses the injected SubtleCrypto and the requested category", async () => {
  const {deps} = makeDeps();
  const seen = [];
  const subtle = {
    digest: async (algorithm, data) => {
      seen.push(algorithm);
      return globalThis.crypto.subtle.digest(algorithm, data);
    },
  };
  const {file} = makeFile(PNG_10x20);
  const prepared = await prepareLocalAssetImport(file, "background", {...deps, subtle});

  assert.deepEqual(seen, ["SHA-256"]);
  assert.ok(prepared.ref.startsWith("local:background:sha256:"));
});

test("prepare stops at the first inspection failure and writes nothing", async () => {
  const cases = [
    ["unsupported-format", new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0])],
    ["malformed", buildPng({width: 10, height: 10}).slice(0, 20)],
    ["dimensions-too-large", buildPng({width: 8193, height: 16})],
    ["too-many-pixels", buildPng({width: 7072, height: 7072})],
  ];

  for (const [code, bytes] of cases) {
    const {deps, log} = makeDeps();
    const {file} = makeFile(bytes);

    await rejectsWithCode(prepareLocalAssetImport(file, "pose", deps), code);
    // Rejected during validation: never hashed, decoded or thumbnailed.
    assert.deepEqual(log.phases, ["reading", "validating"], code);
    assert.equal(log.decode.length, 0, code);
    assert.equal(log.thumbnail.length, 0, code);
  }
});

test("prepare accepts a decoded size equal to or swapped from the header size", async () => {
  for (const [width, height] of [
    [10, 20],
    [20, 10],
  ]) {
    const {deps, log} = makeDeps({decodedWidth: width, decodedHeight: height});
    const {file} = makeFile(PNG_10x20);
    const prepared = await prepareLocalAssetImport(file, "pose", deps);

    // Payload metadata always records the header size, never the decoded one.
    assert.equal(prepared.payloadMeta.width, 10);
    assert.equal(prepared.payloadMeta.height, 20);
    assert.equal(log.closed, 1);
  }
});

test("prepare rejects any other decoded size as decode-failed and still closes the bitmap", async () => {
  for (const [width, height] of [
    [10, 21],
    [11, 20],
    [10, 10],
    [1, 1],
  ]) {
    const {deps, log} = makeDeps({decodedWidth: width, decodedHeight: height});
    const {file} = makeFile(PNG_10x20);

    await rejectsWithCode(prepareLocalAssetImport(file, "pose", deps), "decode-failed");
    assert.equal(log.closed, 1);
    assert.equal(log.thumbnail.length, 0);
  }
});

test("prepare maps decode errors to decode-failed", async () => {
  const {deps, log} = makeDeps({
    deps: {
      decode: async () => {
        throw new Error("The source image cannot be decoded.");
      },
    },
  });
  const {file} = makeFile(PNG_10x20);

  await rejectsWithCode(prepareLocalAssetImport(file, "pose", deps), "decode-failed");
  assert.equal(log.thumbnail.length, 0);
});

test("prepare maps thumbnail errors to thumbnail-failed", async () => {
  const {deps} = makeDeps({
    deps: {
      makeThumbnail: async () => {
        throw new Error("no canvas");
      },
    },
  });
  const {file} = makeFile(PNG_10x20);

  await rejectsWithCode(
    prepareLocalAssetImport(file, "pose", deps),
    "thumbnail-failed",
  );
});

test("prepare maps an unreadable file to a LocalAssetImportError", async () => {
  const {deps} = makeDeps();
  const file = {
    name: "gone.png",
    size: 100,
    arrayBuffer: async () => {
      throw new Error("NotReadableError");
    },
  };

  await assert.rejects(
    prepareLocalAssetImport(file, "pose", deps),
    (error) => error instanceof LocalAssetImportError && error.code === "malformed",
  );
});

test("default labels drop the last extension, trim and cap at 80 code points (D-12)", async () => {
  const cases = [
    ["IMG_0421.webp", "pose", "IMG_0421"],
    [".png", "pose", "Untitled pose"],
    [".png", "background", "Untitled background"],
    ["   .png", "pose", "Untitled pose"],
    ["", "background", "Untitled background"],
    ["   ", "pose", "Untitled pose"],
    ["my.photo.v2.jpeg", "pose", "my.photo.v2"],
    ["no-extension", "pose", "no-extension"],
    ["  padded name  .png", "pose", "padded name"],
    [`${"a".repeat(100)}.png`, "pose", "a".repeat(80)],
    [`${"😀".repeat(90)}.png`, "pose", "😀".repeat(80)],
  ];

  for (const [name, category, expected] of cases) {
    const {deps} = makeDeps();
    const {file} = makeFile(PNG_10x20, name);
    const prepared = await prepareLocalAssetImport(file, category, deps);

    assert.equal(prepared.defaultLabel, expected, JSON.stringify(name));
    assert.equal(prepared.originalFilename, name);
    // A default label must always satisfy the label rules.
    assert.equal(normalizeLocalAssetLabel(prepared.defaultLabel).ok, true);
  }
});

test("commit applies the import under the exclusive lock and announces the change", async () => {
  const library = makeLibrary();
  const heldDuringApply = [];
  const realApply = library.store.apply.bind(library.store);

  library.store.apply = async (mutation) => {
    heldDuringApply.push(library.locks.held(constants.ASSET_LIBRARY_LOCK));
    return realApply(mutation);
  };

  const {deps} = makeDeps();
  const {file} = makeFile(PNG_10x20, "Hero.png");
  const prepared = await prepareLocalAssetImport(file, "pose", deps);
  const result = await commitPreparedLocalAssetImport(prepared, library, {
    storage: undefined,
  });

  assert.deepEqual(result, {ref: prepared.ref, created: true});
  assert.deepEqual(heldDuringApply, [{exclusive: true, shared: 0}]);
  assert.deepEqual(
    library.locks.requests.map(({name, mode}) => ({name, mode})),
    [{name: constants.ASSET_LIBRARY_LOCK, mode: "exclusive"}],
  );
  assert.deepEqual(library.posted, [
    {
      type: "asset-library-changed",
      refs: [prepared.ref],
      digests: [prepared.ref.slice(prepared.ref.lastIndexOf(":") + 1)],
    },
  ]);

  const mutation = library.store.applyCalls[0];

  assert.equal(mutation.kind, "import");
  assert.equal(mutation.ref, prepared.ref);
  assert.equal(mutation.defaultLabel, "Hero");
  assert.equal(mutation.originalFilename, "Hero.png");
  assert.equal(mutation.blob, prepared.blob);
  assert.equal(mutation.thumbnail, prepared.thumbnail);
  assert.deepEqual(mutation.payloadMeta, prepared.payloadMeta);
  assert.equal(new Date(mutation.createdAt).toISOString(), mutation.createdAt);
  assert.equal((await library.store.getAssetRow(prepared.ref)).status, "present");
});

test("committing the same bytes again reports created=false and still announces", async () => {
  const library = makeLibrary();
  const {deps} = makeDeps();
  const first = await prepareLocalAssetImport(makeFile(PNG_10x20).file, "pose", deps);
  const second = await prepareLocalAssetImport(
    makeFile(PNG_10x20, "other.png").file,
    "pose",
    deps,
  );
  const noStorage = {storage: undefined};

  assert.equal(
    (await commitPreparedLocalAssetImport(first, library, noStorage)).created,
    true,
  );
  assert.equal(
    (await commitPreparedLocalAssetImport(second, library, noStorage)).created,
    false,
  );
  assert.equal(library.posted.length, 2);
});

test("commit maps quota failures to storage-full and other failures to storage-error", async () => {
  const {deps} = makeDeps();
  const prepared = await prepareLocalAssetImport(makeFile(PNG_10x20).file, "pose", deps);
  const noStorage = {storage: undefined};

  const quota = makeLibrary();

  quota.store.failNextApply();
  await rejectsWithCode(
    commitPreparedLocalAssetImport(prepared, quota, noStorage),
    "storage-full",
  );
  assert.deepEqual(quota.posted, []);
  assert.deepEqual(quota.locks.held(constants.ASSET_LIBRARY_LOCK), {
    exclusive: false,
    shared: 0,
  });
  assert.equal((await quota.store.getAssetRow(prepared.ref)).status, "absent");

  const other = makeLibrary();

  other.store.failNextApply(new Error("transaction aborted"));
  await rejectsWithCode(
    commitPreparedLocalAssetImport(prepared, other, noStorage),
    "storage-error",
  );
  assert.deepEqual(other.posted, []);

  const nonError = makeLibrary();

  nonError.store.failNextApply("weird");
  await rejectsWithCode(
    commitPreparedLocalAssetImport(prepared, nonError, noStorage),
    "storage-error",
  );

  // The same prepared import commits fine afterwards.
  assert.equal(
    (await commitPreparedLocalAssetImport(prepared, quota, noStorage)).created,
    true,
  );
});

test("a throwing channel does not fail a committed import", async () => {
  const library = makeLibrary();

  library.channel.post = () => {
    throw new Error("channel closed");
  };

  const {deps} = makeDeps();
  const prepared = await prepareLocalAssetImport(makeFile(PNG_10x20).file, "pose", deps);

  assert.equal(
    (await commitPreparedLocalAssetImport(prepared, library, {storage: undefined}))
      .created,
    true,
  );
});

test("importLocalAsset runs prepare then storing then commit", async () => {
  const library = makeLibrary();
  const {deps, log} = makeDeps();
  const original = library.store.apply.bind(library.store);

  library.store.apply = (mutation) => {
    log.phases.push("apply");
    return original(mutation);
  };

  const {file} = makeFile(PNG_10x20, "Pose.png");
  const result = await importLocalAsset(file, "pose", library, {
    ...deps,
    storage: undefined,
  });

  assert.equal(result.created, true);
  assert.deepEqual(log.phases, ["reading", "validating", "hashing", "storing", "apply"]);
  assert.equal(library.store.applyCalls.length, 1);
});

test("importLocalAsset writes nothing when prepare fails", async () => {
  const library = makeLibrary();
  const {deps, log} = makeDeps({decodedWidth: 99, decodedHeight: 99});
  const {file} = makeFile(PNG_10x20);

  await rejectsWithCode(importLocalAsset(file, "pose", library, deps), "decode-failed");
  assert.deepEqual(log.phases, ["reading", "validating", "hashing"]);
  assert.equal(library.store.applyCalls.length, 0);
  assert.deepEqual(library.posted, []);
  assert.equal(library.locks.requests.length, 0);
});

test("importLocalAsset maps storage failures after the storing phase", async () => {
  const library = makeLibrary();
  const {deps, log} = makeDeps();

  library.store.failNextApply();

  const {file} = makeFile(PNG_10x20);

  await rejectsWithCode(
    importLocalAsset(file, "pose", library, {...deps, storage: undefined}),
    "storage-full",
  );
  assert.deepEqual(log.phases, ["reading", "validating", "hashing", "storing"]);
});

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a successful commit asks for persistent storage once; failures do not", async () => {
  resetPersistentStorageRequestForTests();

  const persistCalls = [];
  const storage = {
    persist: async () => {
      persistCalls.push(1);
      return true;
    },
  };
  const {deps} = makeDeps();
  const failing = makeLibrary();

  failing.store.failNextApply();

  const prepared = await prepareLocalAssetImport(makeFile(PNG_10x20).file, "pose", deps);

  await assert.rejects(() =>
    commitPreparedLocalAssetImport(prepared, failing, {storage}),
  );
  assert.equal(persistCalls.length, 0);

  const library = makeLibrary();

  await commitPreparedLocalAssetImport(prepared, library, {storage});
  await commitPreparedLocalAssetImport(prepared, library, {storage});
  await flushMicrotasks();
  assert.equal(persistCalls.length, 1);
  resetPersistentStorageRequestForTests();
});

test("requestPersistentStorageOnce is best effort", async () => {
  resetPersistentStorageRequestForTests();
  // No storage manager: nothing to do, no throw.
  await requestPersistentStorageOnce({storage: undefined});
  resetPersistentStorageRequestForTests();

  let calls = 0;
  const rejecting = {
    persist: async () => {
      calls += 1;
      throw new Error("denied");
    },
  };

  await requestPersistentStorageOnce({storage: rejecting});
  await requestPersistentStorageOnce({storage: rejecting});
  assert.equal(calls, 1);
  resetPersistentStorageRequestForTests();

  const throwing = {
    persist: () => {
      throw new Error("sync failure");
    },
  };

  await requestPersistentStorageOnce({storage: throwing});
  resetPersistentStorageRequestForTests();

  let skipped = 0;

  await requestPersistentStorageOnce({
    storage: {
      persisted: async () => true,
      persist: async () => {
        skipped += 1;
        return true;
      },
    },
  });
  assert.equal(skipped, 0, "an already persistent origin is not asked again");
  resetPersistentStorageRequestForTests();
});

/* ------------------------------------------------------------ thumbnails */

test("fitWithin scales to fit 256x256 without upscaling and keeps each side at least 1", () => {
  assert.deepEqual(fitWithin(1000, 500, 256), {width: 256, height: 128});
  assert.deepEqual(fitWithin(500, 1000, 256), {width: 128, height: 256});
  assert.deepEqual(fitWithin(256, 256, 256), {width: 256, height: 256});
  assert.deepEqual(fitWithin(100, 50, 256), {width: 100, height: 50});
  assert.deepEqual(fitWithin(1, 1, 256), {width: 1, height: 1});
  assert.deepEqual(fitWithin(8192, 1, 256), {width: 256, height: 1});
  assert.deepEqual(fitWithin(1, 8192, 256), {width: 1, height: 256});
  assert.deepEqual(fitWithin(8192, 6103, 256), {width: 256, height: 191});
});

test("commit resolves even when persist() never settles", async () => {
  resetPersistentStorageRequestForTests();

  let persistCalls = 0;
  const storage = {
    persisted: async () => false,
    persist: () => {
      persistCalls += 1;
      return new Promise(() => {}); // e.g. a Firefox permission prompt left open
    },
  };
  const library = makeLibrary();
  const {deps} = makeDeps();
  const prepared = await prepareLocalAssetImport(makeFile(PNG_10x20).file, "pose", deps);
  const outcome = await Promise.race([
    commitPreparedLocalAssetImport(prepared, library, {storage}),
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), 500)),
  ]);

  assert.deepEqual(outcome, {ref: prepared.ref, created: true});
  await flushMicrotasks();
  assert.equal(persistCalls, 1);
  resetPersistentStorageRequestForTests();
});

test("the persist-once flag is not consumed when persist is unavailable", async () => {
  resetPersistentStorageRequestForTests();

  await requestPersistentStorageOnce({storage: {}});

  let persistCalls = 0;
  const storage = {
    persist: async () => {
      persistCalls += 1;
      return true;
    },
  };

  await requestPersistentStorageOnce({storage});
  await requestPersistentStorageOnce({storage});
  assert.equal(persistCalls, 1);
  resetPersistentStorageRequestForTests();
});

test("prepare wraps a hashing failure as a storage-error LocalAssetImportError", async () => {
  const {deps, log} = makeDeps();
  const boom = new Error("subtle is unavailable");
  const subtle = {
    digest: async () => {
      throw boom;
    },
  };
  const {file} = makeFile(PNG_10x20);

  await assert.rejects(
    prepareLocalAssetImport(file, "pose", {...deps, subtle}),
    (error) =>
      error instanceof LocalAssetImportError &&
      error.code === "storage-error" &&
      error.cause === boom,
  );
  assert.deepEqual(log.phases, ["reading", "validating", "hashing"]);
  assert.equal(log.decode.length, 0);
});
