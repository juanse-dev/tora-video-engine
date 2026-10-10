import assert from "node:assert/strict";
import {test} from "node:test";
import {sha256Hex} from "../src/localAssets/hash.ts";
import {
  MAX_BROWSER_STORY_LOCAL_ASSET_BYTES,
  MAX_BROWSER_STORY_LOCAL_ASSET_PIXELS,
  MAX_BROWSER_STORY_LOCAL_ASSET_REFS,
} from "../src/localAssets/limits.ts";
import {buildLocalAssetRef} from "../src/localAssets/refs.ts";
import {ASSET_LIBRARY_LOCK} from "../src/web/assetLibrary/constants.ts";
import {IntegrityCache} from "../src/web/assetLibrary/integrity.ts";
import {
  createLocalAssetRenderPreparation,
  describeLocalAssetRenderBlock,
  resolveStoryLocalAssets,
  resolveStoryLocalAssetsForPreview,
} from "../src/web/localAssetState.ts";
import {buildPng} from "./helpers/imageBytes.mjs";
import {
  createMemoryAssetStore,
  createMemoryLockManager,
} from "./helpers/memoryAssetStore.mjs";

const MIB = 1024 * 1024;
const DISABLED_MESSAGE = "My assets needs Web Locks (test).";
const UNREADY_MESSAGE = "Close other Tora tabs (test).";

const digestOf = (n) => n.toString(16).padStart(64, "0");
const poseRef = (n) => buildLocalAssetRef("pose", digestOf(n));
const backgroundRef = (n) => buildLocalAssetRef("background", digestOf(n));

const storyOf = (scenes) => ({
  title: "Local assets",
  scenes: scenes.map(([pose, background]) => ({
    pose,
    background,
    duration: 1,
    caption: "x",
  })),
});

const readyLibrary = (store) => ({kind: "ready", store});

const totalReads = (store) =>
  store.reads.assets +
  store.reads.payloadMeta +
  store.reads.blobs +
  store.reads.thumbnails;

const row = () => ({
  label: "Label",
  originalFilename: "file.png",
  createdAt: "2026-01-01T00:00:00.000Z",
});

/** Seeds one real, valid image. Returns its digest, bytes and meta. */
const seedImage = async (store, width, categories = ["pose"]) => {
  const bytes = buildPng({width, height: 3});
  const digest = await sha256Hex(bytes);
  const meta = {
    mimeType: "image/png",
    byteSize: bytes.length,
    width,
    height: 3,
  };

  for (const category of categories) {
    store.setRaw("assets", buildLocalAssetRef(category, digest), row());
  }

  store.setRaw("payloadMeta", digest, meta);
  store.setRaw("blobs", digest, {blob: new Blob([bytes], {type: "image/png"})});

  return {digest, bytes, meta};
};

/** Seeds only a row + metadata (no blob), as the budget tests need. */
const seedMetaOnly = (store, n, meta, category = "pose") => {
  const ref = buildLocalAssetRef(category, digestOf(n));

  store.setRaw("assets", ref, row());
  store.setRaw("payloadMeta", digestOf(n), meta);

  return ref;
};

/** Wraps a store so reads can be listed per digest and hooked. */
const recordingStore = (inner, hooks = {}) => {
  const log = {blobs: [], payloadMeta: [], assets: []};

  return {
    log,
    getAssetRow: async (ref) => {
      log.assets.push(ref);
      return inner.getAssetRow(ref);
    },
    getPayloadMeta: async (digest) => {
      log.payloadMeta.push(digest);
      return inner.getPayloadMeta(digest);
    },
    getBlob: async (digest) => {
      log.blobs.push(digest);
      const result = await inner.getBlob(digest);
      hooks.afterGetBlob?.(digest);
      return result;
    },
    getThumbnail: (digest) => inner.getThumbnail(digest),
    listAssets: (...args) => inner.listAssets(...args),
    countAssets: (category) => inner.countAssets(category),
    apply: (mutation) => inner.apply(mutation),
    close: () => inner.close(),
  };
};

const resolve = (story, store, options = {}) =>
  resolveStoryLocalAssets(
    story,
    options.library ?? readyLibrary(store),
    options.cache ?? new IntegrityCache(),
    options.deps,
  );

test("a bundled-only Story is none and the store is never read", async () => {
  const store = createMemoryAssetStore();
  const state = await resolve(storyOf([["formal", "office"]]), store);

  assert.deepEqual(state, {kind: "none"});
  assert.equal(totalReads(store), 0);
});

test("a disabled library makes every ref unavailable without store reads", async () => {
  const store = createMemoryAssetStore();
  const story = storyOf([
    [poseRef(1), "office"],
    ["formal", backgroundRef(2)],
  ]);
  const state = await resolve(story, store, {
    library: {kind: "disabled", message: DISABLED_MESSAGE},
  });

  assert.equal(state.kind, "resolved");
  assert.equal(state.allReady, false);
  assert.equal(state.failureMessage, null);
  assert.deepEqual(
    state.refs.map((entry) => [entry.usage.ref, entry.status, entry.detail]),
    [
      [poseRef(1), "unavailable", DISABLED_MESSAGE],
      [backgroundRef(2), "unavailable", DISABLED_MESSAGE],
    ],
  );
  assert.equal(state.verified.size, 0);
  assert.equal(state.blobs.size, 0);
  assert.equal(totalReads(store), 0);
});

test("an unavailable library behaves like a disabled one", async () => {
  const store = createMemoryAssetStore();
  const state = await resolve(storyOf([[poseRef(1), "office"]]), store, {
    library: {kind: "unavailable", message: UNREADY_MESSAGE},
  });

  assert.equal(state.kind, "resolved");
  assert.equal(state.refs[0].status, "unavailable");
  assert.equal(state.refs[0].detail, UNREADY_MESSAGE);
  assert.equal(totalReads(store), 0);
});

test("a disabled library with 65 distinct refs is over-budget without storage", async () => {
  const store = createMemoryAssetStore();
  const scenes = Array.from(
    {length: MAX_BROWSER_STORY_LOCAL_ASSET_REFS + 1},
    (_, index) => [poseRef(index + 1), "office"],
  );
  const state = await resolve(storyOf(scenes), store, {
    library: {kind: "disabled", message: DISABLED_MESSAGE},
  });

  assert.equal(state.kind, "over-budget");
  assert.equal(state.usages.length, MAX_BROWSER_STORY_LOCAL_ASSET_REFS + 1);
  assert.deepEqual(state.budget.exceeded, ["refs"]);
  assert.match(state.message, /65 local assets \(limit 64\)/u);
  assert.equal(totalReads(store), 0);
});

test("valid refs are all ready and each distinct digest is read once", async () => {
  const store = createMemoryAssetStore();
  const {digest, meta} = await seedImage(store, 5, ["pose", "background"]);
  const pose = buildLocalAssetRef("pose", digest);
  const background = buildLocalAssetRef("background", digest);
  const story = storyOf(
    Array.from({length: 5}, () => [pose, background]),
  );

  const state = await resolve(story, store);

  assert.equal(state.kind, "resolved");
  assert.equal(state.allReady, true);
  assert.equal(state.failureMessage, null);
  assert.deepEqual(
    state.refs.map((entry) => [entry.usage.ref, entry.status, entry.detail]),
    [
      [pose, "ready", null],
      [background, "ready", null],
    ],
  );
  assert.deepEqual(state.refs[0].usage.sceneIndexes, [0, 1, 2, 3, 4]);
  assert.deepEqual([...state.verified.keys()], [digest]);
  assert.deepEqual(state.verified.get(digest), {digest, ...meta});
  assert.deepEqual([...state.blobs.keys()], [digest]);
  assert.ok(state.blobs.get(digest) instanceof Blob);
  assert.equal(state.blobs.get(digest).type, "image/png");
  assert.equal(store.reads.blobs, 1);
});

test("valid A plus missing B: A is ready, B is missing", async () => {
  const store = createMemoryAssetStore();
  const a = await seedImage(store, 4);
  const pose = buildLocalAssetRef("pose", a.digest);
  const state = await resolve(storyOf([[pose, backgroundRef(9)]]), store);

  assert.equal(state.kind, "resolved");
  assert.equal(state.allReady, false);
  assert.deepEqual(
    state.refs.map((entry) => [entry.usage.ref, entry.status]),
    [
      [pose, "ready"],
      [backgroundRef(9), "missing"],
    ],
  );
  assert.deepEqual([...state.verified.keys()], [a.digest]);
  assert.deepEqual([...state.blobs.keys()], [a.digest]);
});

test("valid A plus corrupt C (another image's bytes): A is ready, C is corrupt", async () => {
  const store = createMemoryAssetStore();
  const a = await seedImage(store, 4);
  const other = buildPng({width: 6, height: 3});
  const cDigest = digestOf(0xc);
  const cRef = buildLocalAssetRef("background", cDigest);

  store.setRaw("assets", cRef, row());
  store.setRaw("payloadMeta", cDigest, {
    mimeType: "image/png",
    byteSize: other.length,
    width: 6,
    height: 3,
  });
  store.setRaw("blobs", cDigest, {blob: new Blob([other])});

  const pose = buildLocalAssetRef("pose", a.digest);
  const state = await resolve(storyOf([[pose, cRef]]), store);

  assert.equal(state.kind, "resolved");
  assert.equal(state.allReady, false);
  assert.equal(state.refs[0].status, "ready");
  assert.equal(state.refs[1].status, "corrupt");
  assert.match(state.refs[1].detail, /SHA-256/u);
  assert.deepEqual([...state.verified.keys()], [a.digest]);
});

test("a row without payloadMeta is missing", async () => {
  const store = createMemoryAssetStore();

  store.setRaw("assets", poseRef(3), row());

  const state = await resolve(storyOf([[poseRef(3), "office"]]), store);

  assert.equal(state.kind, "resolved");
  assert.equal(state.refs[0].status, "missing");
  assert.equal(store.reads.blobs, 0);
});

test("corrupt payloadMeta marks the ref corrupt", async () => {
  const store = createMemoryAssetStore();

  store.setRaw("assets", poseRef(3), row());
  store.setRaw("payloadMeta", digestOf(3), {mimeType: "image/gif"});

  const state = await resolve(storyOf([[poseRef(3), "office"]]), store);

  assert.equal(state.refs[0].status, "corrupt");
  assert.equal(store.reads.blobs, 0);
});

test("a row claiming another digest is corrupt and that digest is never read", async () => {
  const inner = createMemoryAssetStore();
  const other = await seedImage(inner, 7);

  inner.setRaw("assets", poseRef(5), {...row(), digest: other.digest});

  const store = recordingStore(inner);
  const state = await resolve(storyOf([[poseRef(5), "office"]]), store);

  assert.equal(state.kind, "resolved");
  assert.equal(state.refs[0].status, "corrupt");
  assert.match(state.refs[0].detail, /digest/u);
  assert.equal(store.log.payloadMeta.includes(other.digest), false);
  assert.equal(store.log.blobs.length, 0);
});

test("a deleted pose row is missing while the background row for the same digest stays ready", async () => {
  const store = createMemoryAssetStore();
  const {digest} = await seedImage(store, 5, ["background"]);
  const pose = buildLocalAssetRef("pose", digest);
  const background = buildLocalAssetRef("background", digest);
  const state = await resolve(storyOf([[pose, background]]), store);

  assert.equal(state.kind, "resolved");
  assert.deepEqual(
    state.refs.map((entry) => [entry.usage.ref, entry.status]),
    [
      [pose, "missing"],
      [background, "ready"],
    ],
  );
  assert.deepEqual([...state.verified.keys()], [digest]);
});

test("a verification failure marks every ref of that digest", async () => {
  const store = createMemoryAssetStore();
  const {digest} = await seedImage(store, 5, ["pose", "background"]);
  const pose = buildLocalAssetRef("pose", digest);
  const background = buildLocalAssetRef("background", digest);

  store.deleteRaw("blobs", digest);

  const state = await resolve(storyOf([[pose, background]]), store);

  assert.deepEqual(
    state.refs.map((entry) => entry.status),
    ["missing", "missing"],
  );
  assert.equal(state.verified.size, 0);
});

test("over budget by refs with missing metadata makes no storage read", async () => {
  const store = createMemoryAssetStore();
  const scenes = Array.from(
    {length: MAX_BROWSER_STORY_LOCAL_ASSET_REFS + 1},
    (_, index) => [poseRef(index + 1), "office"],
  );

  for (let index = 1; index <= MAX_BROWSER_STORY_LOCAL_ASSET_REFS + 1; index += 1) {
    store.setRaw("assets", poseRef(index), row());
  }

  const state = await resolve(storyOf(scenes), store);

  assert.equal(state.kind, "over-budget");
  assert.equal(totalReads(store), 0);
});

test("over budget by bytes is decided from metadata before any blob read", async () => {
  const store = createMemoryAssetStore();
  const count = MAX_BROWSER_STORY_LOCAL_ASSET_BYTES / (16 * MIB) + 1;
  const scenes = [];

  for (let index = 1; index <= count; index += 1) {
    scenes.push([
      seedMetaOnly(store, index, {
        mimeType: "image/png",
        byteSize: 16 * MIB,
        width: 10,
        height: 10,
      }),
      "office",
    ]);
  }

  const state = await resolve(storyOf(scenes), store);

  assert.equal(state.kind, "over-budget");
  assert.deepEqual(state.budget.exceeded, ["bytes"]);
  assert.match(state.message, /272 MiB \(limit 256 MiB\)/u);
  assert.equal(store.reads.blobs, 0);
});

test("over budget by pixels is decided from metadata before any blob read", async () => {
  const store = createMemoryAssetStore();
  const count = MAX_BROWSER_STORY_LOCAL_ASSET_PIXELS / (8000 * 5000) + 1;
  const scenes = [];

  for (let index = 1; index <= count; index += 1) {
    scenes.push([
      seedMetaOnly(store, index, {
        mimeType: "image/png",
        byteSize: 1000,
        width: 8000,
        height: 5000,
      }),
      "office",
    ]);
  }

  const state = await resolve(storyOf(scenes), store);

  assert.equal(state.kind, "over-budget");
  assert.deepEqual(state.budget.exceeded, ["pixels"]);
  assert.equal(store.reads.blobs, 0);
});

test("exactly at the byte and pixel limits proceeds to verification", async () => {
  const store = createMemoryAssetStore();
  const scenes = [];

  for (let index = 1; index <= MAX_BROWSER_STORY_LOCAL_ASSET_BYTES / (16 * MIB); index += 1) {
    scenes.push([
      seedMetaOnly(store, index, {
        mimeType: "image/png",
        byteSize: 16 * MIB,
        width: 10,
        height: 10,
      }),
      "office",
    ]);
  }

  const bytesState = await resolve(storyOf(scenes), store);

  assert.equal(bytesState.kind, "resolved");
  assert.ok(store.reads.blobs > 0);

  const pixelStore = createMemoryAssetStore();
  const pixelScenes = [];

  for (
    let index = 1;
    index <= MAX_BROWSER_STORY_LOCAL_ASSET_PIXELS / (8000 * 5000);
    index += 1
  ) {
    pixelScenes.push([
      seedMetaOnly(pixelStore, index, {
        mimeType: "image/png",
        byteSize: 1000,
        width: 8000,
        height: 5000,
      }),
      "office",
    ]);
  }

  const pixelState = await resolve(storyOf(pixelScenes), pixelStore);

  assert.equal(pixelState.kind, "resolved");
  assert.ok(pixelStore.reads.blobs > 0);
});

test("an already-aborted signal rejects with AbortError before any store read", async () => {
  const store = createMemoryAssetStore();
  const {digest} = await seedImage(store, 4);
  const controller = new AbortController();

  controller.abort();

  await assert.rejects(
    resolve(storyOf([[buildLocalAssetRef("pose", digest), "office"]]), store, {
      deps: {signal: controller.signal},
    }),
    {name: "AbortError"},
  );
  assert.equal(totalReads(store), 0);
});

test("aborting mid-verification stops before the next digest", async () => {
  const inner = createMemoryAssetStore();
  const first = await seedImage(inner, 4);
  const second = await seedImage(inner, 5);
  const third = await seedImage(inner, 6);
  const controller = new AbortController();
  const store = recordingStore(inner, {
    afterGetBlob: () => controller.abort(),
  });
  const story = storyOf([
    [buildLocalAssetRef("pose", first.digest), buildLocalAssetRef("background", second.digest)],
    [buildLocalAssetRef("pose", third.digest), "office"],
  ]);

  // The Story's first-appearance order is pose(first), background(second), pose(third).
  inner.setRaw("assets", buildLocalAssetRef("background", second.digest), row());

  await assert.rejects(
    resolveStoryLocalAssets(story, readyLibrary(store), new IntegrityCache(), {
      signal: controller.signal,
    }),
    {name: "AbortError"},
  );
  assert.equal(store.log.blobs.length, 1);
});

test("the preview wrapper maps a store failure to an unavailable state", async () => {
  const inner = createMemoryAssetStore();
  const failure = new Error("The database connection is closing.");
  const store = {
    ...recordingStore(inner),
    getAssetRow: async () => {
      throw failure;
    },
  };
  const story = storyOf([
    [poseRef(1), "office"],
    ["formal", backgroundRef(2)],
  ]);

  const state = await resolveStoryLocalAssetsForPreview(
    story,
    readyLibrary(store),
    new IntegrityCache(),
  );

  assert.equal(state.kind, "resolved");
  assert.equal(state.allReady, false);
  assert.equal(state.failureMessage, failure.message);
  assert.deepEqual(
    state.refs.map((entry) => [entry.usage.ref, entry.status, entry.detail]),
    [
      [poseRef(1), "unavailable", failure.message],
      [backgroundRef(2), "unavailable", failure.message],
    ],
  );
  assert.equal(state.verified.size, 0);
  assert.equal(state.blobs.size, 0);
  assert.equal(
    describeLocalAssetRenderBlock(state, readyLibrary(store)),
    failure.message,
  );
});

test("the preview wrapper stringifies non-Error rejections", async () => {
  const store = {
    ...recordingStore(createMemoryAssetStore()),
    getAssetRow: () => Promise.reject("boom"),
  };
  const state = await resolveStoryLocalAssetsForPreview(
    storyOf([[poseRef(1), "office"]]),
    readyLibrary(store),
    new IntegrityCache(),
  );

  assert.equal(state.failureMessage, "boom");
});

test("the preview wrapper still rejects with AbortError when aborted", async () => {
  const store = createMemoryAssetStore();
  const controller = new AbortController();

  controller.abort();

  await assert.rejects(
    resolveStoryLocalAssetsForPreview(
      storyOf([[poseRef(1), "office"]]),
      readyLibrary(store),
      new IntegrityCache(),
      {signal: controller.signal},
    ),
    {name: "AbortError"},
  );
});

test("the preview wrapper passes through ordinary results", async () => {
  const store = createMemoryAssetStore();
  const {digest} = await seedImage(store, 4);
  const state = await resolveStoryLocalAssetsForPreview(
    storyOf([[buildLocalAssetRef("pose", digest), "office"]]),
    readyLibrary(store),
    new IntegrityCache(),
  );

  assert.equal(state.kind, "resolved");
  assert.equal(state.allReady, true);
  assert.equal(state.failureMessage, null);
});

test("describeLocalAssetRenderBlock returns messages in priority order", async () => {
  const store = createMemoryAssetStore();
  const ready = readyLibrary(store);
  const disabled = {kind: "disabled", message: DISABLED_MESSAGE};
  const usages = [
    {
      ref: poseRef(1),
      category: "pose",
      digest: digestOf(1),
      sceneIndexes: [0],
    },
  ];
  const refState = (status) => ({usage: usages[0], status, detail: null});
  const resolvedWith = (refs, failureMessage = null) => ({
    kind: "resolved",
    refs,
    verified: new Map(),
    blobs: new Map(),
    allReady: refs.every((entry) => entry.status === "ready"),
    failureMessage,
  });
  const overBudget = {
    kind: "over-budget",
    usages,
    budget: {
      ok: false,
      refCount: 65,
      totalBytes: 0,
      totalPixels: 0,
      exceeded: ["refs"],
    },
    message: "Uses 65 local assets (limit 64).",
  };

  // 1. failureMessage beats a disabled library.
  assert.equal(
    describeLocalAssetRenderBlock(
      resolvedWith([refState("unavailable")], "Reload the page."),
      disabled,
    ),
    "Reload the page.",
  );
  // 2. disabled/unavailable library beats pending, over-budget and unready refs.
  assert.equal(
    describeLocalAssetRenderBlock({kind: "pending", usages}, disabled),
    DISABLED_MESSAGE,
  );
  assert.equal(
    describeLocalAssetRenderBlock(overBudget, {
      kind: "unavailable",
      message: UNREADY_MESSAGE,
    }),
    UNREADY_MESSAGE,
  );
  assert.equal(
    describeLocalAssetRenderBlock(resolvedWith([refState("missing")]), disabled),
    DISABLED_MESSAGE,
  );
  // none never mentions the library.
  assert.equal(describeLocalAssetRenderBlock({kind: "none"}, disabled), null);
  // 3. pending.
  assert.equal(
    describeLocalAssetRenderBlock({kind: "pending", usages}, ready),
    "Checking local assets…",
  );
  // 4. over-budget.
  assert.equal(
    describeLocalAssetRenderBlock(overBudget, ready),
    "Uses 65 local assets (limit 64).",
  );
  // 5. unready refs, counted per distinct ref.
  const second = {...usages[0], ref: backgroundRef(2), category: "background"};
  assert.equal(
    describeLocalAssetRenderBlock(
      resolvedWith([
        refState("missing"),
        {usage: second, status: "corrupt", detail: "x"},
        {usage: {...second, ref: poseRef(3)}, status: "ready", detail: null},
      ]),
      ready,
    ),
    "Browser render is blocked because 2 local asset(s) are unavailable in this browser.",
  );
  // 6. everything ready.
  assert.equal(
    describeLocalAssetRenderBlock(resolvedWith([refState("ready")]), ready),
    null,
  );
  assert.equal(describeLocalAssetRenderBlock({kind: "none"}, ready), null);
});

// --- createLocalAssetRenderPreparation ---------------------------------------

const createFakePool = () => {
  const calls = {acquire: [], release: []};
  const urls = new Map();

  return {
    calls,
    acquire(digest, blob) {
      calls.acquire.push({digest, blob});

      const url = `blob:fake/${digest.slice(-8)}`;
      urls.set(digest, url);

      return url;
    },
    release(digest) {
      calls.release.push(digest);
    },
  };
};

const resolvedTwoRefs = async (store) => {
  const {digest} = await seedImage(store, 5, ["pose", "background"]);
  const other = await seedImage(store, 6, ["pose"]);
  const pose = buildLocalAssetRef("pose", digest);
  const background = buildLocalAssetRef("background", digest);
  const otherPose = buildLocalAssetRef("pose", other.digest);
  const resolved = await resolve(
    storyOf([
      [pose, background],
      [otherPose, "office"],
    ]),
    store,
  );

  assert.equal(resolved.kind, "resolved");
  assert.equal(resolved.allReady, true);

  return {resolved, digest, other, pose, background, otherPose};
};

const prepare = (resolved, store, locks, pool, signal = new AbortController().signal) =>
  createLocalAssetRenderPreparation({resolved, store, locks, pool})(signal);

test("render preparation with an unchanged library returns a frozen map", async () => {
  const store = createMemoryAssetStore();
  const locks = createMemoryLockManager();
  const pool = createFakePool();
  const {resolved, digest, other, pose, background, otherPose} =
    await resolvedTwoRefs(store);

  const result = await prepare(resolved, store, locks, pool);

  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(result.localAssetSources), true);
  assert.deepEqual(Object.keys(result.localAssetSources).sort(), [
    background,
    otherPose,
    pose,
  ].sort());
  assert.deepEqual(result.localAssetSources[pose], {
    kind: "url",
    url: `blob:fake/${digest.slice(-8)}`,
  });
  assert.deepEqual(result.localAssetSources[background], {
    kind: "url",
    url: `blob:fake/${digest.slice(-8)}`,
  });
  assert.deepEqual(result.localAssetSources[otherPose], {
    kind: "url",
    url: `blob:fake/${other.digest.slice(-8)}`,
  });
  // One lease per distinct digest, built from the blobs verified earlier.
  assert.deepEqual(
    pool.calls.acquire.map((call) => call.digest).sort(),
    [digest, other.digest].sort(),
  );
  assert.equal(pool.calls.acquire[0].blob, resolved.blobs.get(pool.calls.acquire[0].digest));
  assert.equal(pool.calls.release.length, 0);

  result.release();
  result.release();

  assert.deepEqual(
    pool.calls.release.sort(),
    [digest, other.digest].sort(),
  );
});

test("render preparation takes the asset lock in shared mode and releases it", async () => {
  const store = createMemoryAssetStore();
  const locks = createMemoryLockManager();
  const {resolved} = await resolvedTwoRefs(store);

  await prepare(resolved, store, locks, createFakePool());

  assert.deepEqual(
    locks.requests.map((request) => [request.name, request.mode, request.granted]),
    [[ASSET_LIBRARY_LOCK, "shared", true]],
  );
  assert.deepEqual(locks.held(ASSET_LIBRARY_LOCK), {exclusive: false, shared: 0});
});

test("render preparation rejects when the pose row was deleted but the background row remains", async () => {
  const store = createMemoryAssetStore();
  const locks = createMemoryLockManager();
  const pool = createFakePool();
  const {resolved, pose} = await resolvedTwoRefs(store);

  store.deleteRaw("assets", pose);

  const result = await prepare(resolved, store, locks, pool);

  assert.deepEqual(result, {
    ok: false,
    message: "Local assets changed while preparing the render. Try again.",
  });
  assert.equal(pool.calls.acquire.length, 0);
});

test("render preparation rejects when payloadMeta changed after resolution", async () => {
  const store = createMemoryAssetStore();
  const locks = createMemoryLockManager();
  const pool = createFakePool();
  const {resolved, digest} = await resolvedTwoRefs(store);

  store.setRaw("payloadMeta", digest, {
    ...store.getRaw("payloadMeta", digest),
    width: 99,
  });

  const result = await prepare(resolved, store, locks, pool);

  assert.equal(result.ok, false);
  assert.equal(
    result.message,
    "Local assets changed while preparing the render. Try again.",
  );
  assert.equal(pool.calls.acquire.length, 0);
});

test("render preparation rejects when payloadMeta disappeared", async () => {
  const store = createMemoryAssetStore();
  const locks = createMemoryLockManager();
  const {resolved, other} = await resolvedTwoRefs(store);

  store.deleteRaw("payloadMeta", other.digest);

  const result = await prepare(resolved, store, locks, createFakePool());

  assert.equal(result.ok, false);
});

test("render preparation aborts while waiting for the shared lock", async () => {
  const store = createMemoryAssetStore();
  const locks = createMemoryLockManager();
  const pool = createFakePool();
  const {resolved} = await resolvedTwoRefs(store);
  const controller = new AbortController();
  let releaseExclusive;
  const holding = locks.request(
    ASSET_LIBRARY_LOCK,
    {mode: "exclusive"},
    () => new Promise((resolveHold) => (releaseExclusive = resolveHold)),
  );
  const pending = prepare(resolved, store, locks, pool, controller.signal);

  controller.abort();

  await assert.rejects(pending, {name: "AbortError"});
  assert.equal(pool.calls.acquire.length, 0);

  releaseExclusive();
  await holding;
});

test("render preparation without all refs ready refuses instead of acquiring urls", async () => {
  const store = createMemoryAssetStore();
  const pool = createFakePool();
  const resolved = await resolve(storyOf([[poseRef(4), "office"]]), store);

  assert.equal(resolved.allReady, false);

  const result = await prepare(
    resolved,
    store,
    createMemoryLockManager(),
    pool,
  );

  assert.equal(result.ok, false);
  assert.equal(pool.calls.acquire.length, 0);
});

test("render preparation releases already acquired urls when acquiring fails", async () => {
  const store = createMemoryAssetStore();
  const {resolved} = await resolvedTwoRefs(store);
  const pool = createFakePool();
  const acquire = pool.acquire.bind(pool);

  pool.acquire = (digest, blob) => {
    if (pool.calls.acquire.length === 1) {
      throw new Error("pool exploded");
    }

    return acquire(digest, blob);
  };

  await assert.rejects(
    prepare(resolved, store, createMemoryLockManager(), pool),
    /pool exploded/u,
  );
  assert.equal(pool.calls.release.length, 1);
});
