import assert from "node:assert/strict";
import {test} from "node:test";
import {buildLocalAssetRef} from "../src/localAssets/refs.ts";
import {IntegrityCache} from "../src/web/assetLibrary/integrity.ts";
import {ObjectUrlPool} from "../src/web/objectUrlPool.ts";
import {
  buildPendingSources,
  createStoryLocalAssetsController,
} from "../src/web/storyLocalAssetsController.ts";

const digestOf = (n) => n.toString(16).padStart(64, "0");
const poseRef = (n) => buildLocalAssetRef("pose", digestOf(n));
const backgroundRef = (n) => buildLocalAssetRef("background", digestOf(n));

const storyOf = (scenes) => ({
  title: "Hook",
  scenes: scenes.map(([pose, background]) => ({
    pose,
    background,
    duration: 1,
    caption: "x",
  })),
});

const usageOf = (ref, category, n) => ({
  ref,
  category,
  digest: digestOf(n),
  sceneIndexes: [0],
});

const library = {kind: "disabled", message: "off"};

/** A resolved state with the given ready and missing [ref, category, n] refs. */
const resolvedState = ({ready = [], missing = []}) => {
  const blobs = new Map();
  const verified = new Map();
  const refs = [];

  for (const [ref, category, n] of ready) {
    blobs.set(digestOf(n), new Blob([String(n)]));
    verified.set(digestOf(n), {digest: digestOf(n)});
    refs.push({usage: usageOf(ref, category, n), status: "ready", detail: null});
  }

  for (const [ref, category, n] of missing) {
    refs.push({
      usage: usageOf(ref, category, n),
      status: "missing",
      detail: "gone",
    });
  }

  return {
    kind: "resolved",
    refs,
    verified,
    blobs,
    allReady: missing.length === 0,
    failureMessage: null,
  };
};

const createHarness = () => {
  const created = [];
  const revoked = [];
  const pool = new ObjectUrlPool({
    create: () => {
      const url = `blob:test/${created.length}`;

      created.push(url);

      return url;
    },
    revoke: (url) => revoked.push(url),
  });
  const calls = [];
  const resolve = (story, lib, cache, deps) =>
    new Promise((resolvePromise, reject) => {
      calls.push({story, signal: deps.signal, resolvePromise, reject});
      deps.signal.addEventListener("abort", () => reject(deps.signal.reason));
    });
  const controller = createStoryLocalAssetsController({
    pool,
    cache: new IntegrityCache(),
    resolve,
  });

  return {pool, created, revoked, calls, controller, settled: []};
};

const tick = () => new Promise((resolvePromise) => setImmediate(resolvePromise));

test("starting a new generation aborts the previous generation's signal", async () => {
  const h = createHarness();
  const story = storyOf([[poseRef(1), "office"]]);

  h.controller.start(story, library, (snapshot) => h.settled.push(snapshot));
  h.controller.start(story, library, (snapshot) => h.settled.push(snapshot));

  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.calls[1].signal.aborted, false);

  h.controller.start(story, library, (snapshot) => h.settled.push(snapshot));

  assert.equal(h.calls[1].signal.aborted, true);
  assert.equal(h.calls[2].signal.aborted, false);
  await tick();
  assert.equal(h.settled.length, 0);
});

test("a superseded generation's result is ignored and acquires no URLs", async () => {
  const h = createHarness();
  const story = storyOf([[poseRef(1), "office"]]);

  h.controller.start(story, library, (snapshot) => h.settled.push(snapshot));
  h.controller.start(story, library, (snapshot) => h.settled.push(snapshot));
  // A slow resolution that resolves after it was superseded.
  h.calls[0].resolvePromise(resolvedState({ready: [[poseRef(1), "pose", 1]]}));
  await tick();

  assert.equal(h.settled.length, 0);
  assert.equal(h.created.length, 0);

  h.calls[1].resolvePromise(resolvedState({ready: [[poseRef(2), "pose", 2]]}));
  await tick();

  assert.equal(h.settled.length, 1);
  assert.equal(h.created.length, 1);
});

test("a resolved state leases URLs for ready refs only", async () => {
  const h = createHarness();
  const story = storyOf([[poseRef(1), backgroundRef(2)]]);

  h.controller.start(story, library, (snapshot) => h.settled.push(snapshot));
  h.calls[0].resolvePromise(
    resolvedState({
      ready: [[poseRef(1), "pose", 1]],
      missing: [[backgroundRef(2), "background", 2]],
    }),
  );
  await tick();

  const [snapshot] = h.settled;

  assert.deepEqual(snapshot.sources, {
    [poseRef(1)]: {kind: "url", url: "blob:test/0"},
  });
  assert.equal(snapshot.state.kind, "resolved");
  assert.deepEqual(h.revoked, []);

  snapshot.lease.release();
  snapshot.lease.release();
  assert.deepEqual(h.revoked, ["blob:test/0"]);
});

test("a digest shared by pose and background shares one URL", async () => {
  const h = createHarness();
  const digest = digestOf(4);
  const pose = buildLocalAssetRef("pose", digest);
  const background = buildLocalAssetRef("background", digest);

  h.controller.start(storyOf([[pose, background]]), library, (s) =>
    h.settled.push(s),
  );
  h.calls[0].resolvePromise(
    resolvedState({
      ready: [
        [pose, "pose", 4],
        [background, "background", 4],
      ],
    }),
  );
  await tick();

  const {sources, lease} = h.settled[0];

  assert.equal(sources[pose].url, sources[background].url);
  assert.equal(h.created.length, 1);

  lease.release();
  assert.equal(h.revoked.length, 1);
});

test("an older lease stays valid until it is released explicitly", async () => {
  const h = createHarness();
  const story = storyOf([[poseRef(1), "office"]]);

  h.controller.start(story, library, (s) => h.settled.push(s));
  h.calls[0].resolvePromise(resolvedState({ready: [[poseRef(1), "pose", 1]]}));
  await tick();
  h.controller.start(story, library, (s) => h.settled.push(s));
  h.calls[1].resolvePromise(resolvedState({ready: [[poseRef(1), "pose", 1]]}));
  await tick();

  assert.equal(
    h.settled[0].sources[poseRef(1)].url,
    h.settled[1].sources[poseRef(1)].url,
  );
  assert.equal(h.created.length, 1);

  h.settled[0].lease.release();
  assert.deepEqual(h.revoked, []);

  h.settled[1].lease.release();
  assert.equal(h.revoked.length, 1);
});

test("none settles with undefined sources", async () => {
  const h = createHarness();

  h.controller.start(storyOf([["formal", "office"]]), library, (s) =>
    h.settled.push(s),
  );
  h.calls[0].resolvePromise({kind: "none"});
  await tick();

  assert.deepEqual(h.settled[0].state, {kind: "none"});
  assert.equal(h.settled[0].sources, undefined);
  h.settled[0].lease.release();
});

test("over-budget settles with no sources", async () => {
  const h = createHarness();
  const state = {kind: "over-budget", usages: [], budget: {}, message: "too big"};

  h.controller.start(storyOf([[poseRef(1), "office"]]), library, (s) =>
    h.settled.push(s),
  );
  h.calls[0].resolvePromise(state);
  await tick();

  assert.equal(h.settled[0].state, state);
  assert.equal(h.settled[0].sources, undefined);
});

test("a non-abort rejection settles as an unavailable state, never pending", async () => {
  const h = createHarness();
  const story = storyOf([[poseRef(1), backgroundRef(2)]]);

  h.controller.start(story, library, (s) => h.settled.push(s));
  h.calls[0].reject(new Error("connection closed"));
  await tick();

  const [snapshot] = h.settled;

  assert.equal(snapshot.state.kind, "resolved");
  assert.equal(snapshot.state.failureMessage, "connection closed");
  assert.deepEqual(
    snapshot.state.refs.map((entry) => entry.status),
    ["unavailable", "unavailable"],
  );
  assert.deepEqual(snapshot.sources, {});
});

test("an acquire failure releases already-leased URLs and settles as unavailable", async () => {
  const revoked = [];
  const settled = [];
  let creates = 0;
  const pool = new ObjectUrlPool({
    create: () => {
      creates += 1;

      if (creates === 2) {
        throw new Error("object URL quota");
      }

      return `blob:x/${creates}`;
    },
    revoke: (url) => revoked.push(url),
  });
  const controller = createStoryLocalAssetsController({
    pool,
    cache: new IntegrityCache(),
    resolve: () =>
      Promise.resolve(
        resolvedState({
          ready: [
            [poseRef(1), "pose", 1],
            [backgroundRef(2), "background", 2],
          ],
        }),
      ),
  });

  controller.start(storyOf([[poseRef(1), backgroundRef(2)]]), library, (s) =>
    settled.push(s),
  );
  await tick();

  assert.equal(settled.length, 1);
  assert.equal(settled[0].state.failureMessage, "object URL quota");
  assert.deepEqual(settled[0].sources, {});
  assert.deepEqual(revoked, ["blob:x/1"]);
});

test("cancel aborts the generation and suppresses its result", async () => {
  const h = createHarness();
  const cancel = h.controller.start(
    storyOf([[poseRef(1), "office"]]),
    library,
    (s) => h.settled.push(s),
  );

  cancel();
  assert.equal(h.calls[0].signal.aborted, true);
  await tick();
  assert.equal(h.settled.length, 0);
});

test("buildPendingSources keeps urls for refs still in the Story and marks the rest pending", () => {
  const usages = [
    usageOf(poseRef(1), "pose", 1),
    usageOf(backgroundRef(2), "background", 2),
    usageOf(poseRef(3), "pose", 3),
  ];
  const previous = {
    [poseRef(1)]: {kind: "url", url: "blob:keep"},
    [backgroundRef(2)]: {kind: "pending"},
    [poseRef(9)]: {kind: "url", url: "blob:gone"},
  };

  assert.deepEqual(buildPendingSources(usages, previous), {
    [poseRef(1)]: {kind: "url", url: "blob:keep"},
    [backgroundRef(2)]: {kind: "pending"},
    [poseRef(3)]: {kind: "pending"},
  });
  assert.deepEqual(buildPendingSources(usages, undefined), {
    [poseRef(1)]: {kind: "pending"},
    [backgroundRef(2)]: {kind: "pending"},
    [poseRef(3)]: {kind: "pending"},
  });
  assert.equal(buildPendingSources([], previous), undefined);
});
