import assert from "node:assert/strict";
import {test} from "node:test";
import {collectStoryLocalAssetUsages} from "../src/localAssets/readiness.ts";
import {buildLocalAssetRef} from "../src/localAssets/refs.ts";
import {IntegrityCache} from "../src/web/assetLibrary/integrity.ts";
import {ObjectUrlPool} from "../src/web/objectUrlPool.ts";
import {
  buildPendingSources,
  createStoryLocalAssetsController,
  selectVisibleLocalAssets,
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
  const resolve = (story, _lib, _cache, deps) =>
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

// --- lease lifetime (R5): the controller owns every lease it hands out ------

/** Starts a generation and settles it with the given ready [ref, category, n]. */
const settleWith = async (h, story, ready) => {
  const index = h.calls.length;

  h.controller.start(story, library, (s) => h.settled.push(s));
  h.calls[index].resolvePromise(resolvedState({ready}));
  await tick();

  return h.settled[h.settled.length - 1];
};

test("dispose releases a snapshot that settled but was never committed", async () => {
  const h = createHarness();
  const story = storyOf([[poseRef(1), "office"]]);

  await settleWith(h, story, [[poseRef(1), "pose", 1]]);
  assert.equal(h.created.length, 1);
  assert.deepEqual(h.revoked, []);

  h.controller.dispose();
  assert.deepEqual(h.revoked, ["blob:test/0"]);
});

test("committing the newer of two settled snapshots releases the older one", async () => {
  const h = createHarness();
  const story = storyOf([[poseRef(1), "office"]]);
  const first = await settleWith(h, story, [[poseRef(1), "pose", 1]]);
  const second = await settleWith(h, story, [[poseRef(2), "pose", 2]]);

  assert.deepEqual(h.revoked, []);

  h.controller.commit(second);
  assert.deepEqual(h.revoked, [first.sources[poseRef(1)].url]);

  // Committing again, or committing the older snapshot, changes nothing.
  h.controller.commit(second);
  h.controller.commit(first);
  assert.equal(h.revoked.length, 1);
});

test("after commit a URL shared by the old and the new snapshot stays live", async () => {
  const h = createHarness();
  const story = storyOf([[poseRef(1), "office"]]);
  const first = await settleWith(h, story, [[poseRef(1), "pose", 1]]);
  const second = await settleWith(h, story, [[poseRef(1), "pose", 1]]);

  assert.equal(
    first.sources[poseRef(1)].url,
    second.sources[poseRef(1)].url,
  );

  h.controller.commit(second);
  assert.deepEqual(h.revoked, []);

  h.controller.dispose();
  assert.equal(h.revoked.length, 1);
});

test("dispose leaves the pool balanced with every URL revoked", async () => {
  const h = createHarness();
  const story = storyOf([[poseRef(1), backgroundRef(2)]]);
  const first = await settleWith(h, story, [
    [poseRef(1), "pose", 1],
    [backgroundRef(2), "background", 2],
  ]);

  h.controller.commit(first);

  const second = await settleWith(h, story, [[poseRef(1), "pose", 1]]);
  const third = await settleWith(h, story, [[poseRef(3), "pose", 3]]);

  h.controller.commit(second);
  h.controller.dispose();

  assert.equal(third.state.kind, "resolved");
  assert.equal(h.revoked.length, h.created.length);
  assert.equal(new Set(h.revoked).size, h.created.length);

  // Releasing snapshots again after dispose is a no-op.
  first.lease.release();
  second.lease.release();
  third.lease.release();
  assert.equal(h.revoked.length, h.created.length);
});

test("dispose aborts the generation in flight and suppresses its result", async () => {
  const h = createHarness();

  h.controller.start(storyOf([[poseRef(1), "office"]]), library, (s) =>
    h.settled.push(s),
  );
  h.controller.dispose();

  assert.equal(h.calls[0].signal.aborted, true);
  await tick();
  assert.equal(h.settled.length, 0);
});

test("a disposed controller can start again", async () => {
  const h = createHarness();
  const story = storyOf([[poseRef(1), "office"]]);

  h.controller.dispose();

  const snapshot = await settleWith(h, story, [[poseRef(1), "pose", 1]]);

  assert.equal(snapshot.state.kind, "resolved");
  h.controller.dispose();
  assert.equal(h.revoked.length, 1);
});

// --- stale-while-revalidate (R8): selectVisibleLocalAssets ------------------

const readyState = (n) =>
  resolvedState({ready: [[poseRef(n), "pose", n]]});

const settledFor = (story, lib, n) => ({
  snapshot: {
    state: readyState(n),
    sources: {[poseRef(n)]: {kind: "url", url: `blob:s/${n}`}},
    lease: {release() {}},
  },
  story,
  library: lib,
});

const select = (input) =>
  selectVisibleLocalAssets({
    usages: collectStoryLocalAssetUsages(input.story),
    ...input,
  });

test("a caption-only or refresh-only generation keeps the previous state and sources visible", () => {
  const story = storyOf([[poseRef(1), "office"]]);
  const settled = settledFor(story, library, 1);

  const stale = select({story, library, settled});

  assert.equal(stale.state, settled.snapshot.state);
  assert.equal(stale.sources, settled.snapshot.sources);
});

test("a settled result for the current token is shown as is", () => {
  const story = storyOf([[poseRef(1), "office"]]);
  const settled = settledFor(story, library, 1);
  const shown = select({story, library, settled});

  assert.equal(shown.state, settled.snapshot.state);
  assert.equal(shown.sources, settled.snapshot.sources);
});

test("a refresh that resolves to a different state replaces the stale one", () => {
  const story = storyOf([[poseRef(1), backgroundRef(2)]]);
  const before = settledFor(story, library, 1);
  const after = {
    ...before,
    snapshot: {
      state: resolvedState({
        ready: [[poseRef(1), "pose", 1]],
        missing: [[backgroundRef(2), "background", 2]],
      }),
      sources: {[poseRef(1)]: {kind: "url", url: "blob:s/1"}},
      lease: {release() {}},
    },
  };

  assert.equal(
    select({story, library, settled: before}).state.allReady,
    true,
  );
  assert.equal(
    select({story, library, settled: after}).state.allReady,
    false,
  );
});

test("a Story change still shows pending, keeping URLs of refs that remain", () => {
  const story = storyOf([[poseRef(1), "office"]]);
  const settled = settledFor(story, library, 1);
  const next = storyOf([[poseRef(1), backgroundRef(2)]]);
  const pending = select({story: next, library, settled});

  assert.equal(pending.state.kind, "pending");
  assert.deepEqual(pending.sources, {
    [poseRef(1)]: {kind: "url", url: "blob:s/1"},
    [backgroundRef(2)]: {kind: "pending"},
  });
});

test("a library change shows pending, and an opening library is pending", () => {
  const story = storyOf([[poseRef(1), "office"]]);
  const settled = settledFor(story, library, 1);
  const otherLibrary = {kind: "disabled", message: "off"};

  assert.equal(
    select({story, library: otherLibrary, settled}).state.kind,
    "pending",
  );
  assert.equal(
    select({story, library: null, settled: null}).state.kind,
    "pending",
  );
});

test("a Story without local refs is none, and no settled result means pending", () => {
  const bundled = storyOf([["formal", "office"]]);
  const local = storyOf([[poseRef(1), "office"]]);

  assert.deepEqual(
    select({story: bundled, library, settled: null}),
    {state: {kind: "none"}, sources: undefined},
  );
  assert.equal(
    select({story: local, library, settled: null}).state.kind,
    "pending",
  );
});

test("a caption-only Story change keeps the settled state and sources", () => {
  const story = storyOf([[poseRef(1), "office"]]);
  const settled = settledFor(story, library, 1);
  const edited = {
    ...story,
    scenes: story.scenes.map((scene) => ({...scene, caption: "edited"})),
  };
  const shown = select({story: edited, library, settled});

  assert.equal(shown.state, settled.snapshot.state);
  assert.equal(shown.sources, settled.snapshot.sources);
});

test("a ref change shows pending even when other refs stay", () => {
  const story = storyOf([[poseRef(1), "office"]]);
  const settled = settledFor(story, library, 1);
  const swapped = storyOf([[poseRef(2), "office"]]);
  const shown = select({story: swapped, library, settled});

  assert.equal(shown.state.kind, "pending");
  assert.deepEqual(shown.sources, {[poseRef(2)]: {kind: "pending"}});
});

test("a sceneIndexes change shows pending, keeping the URL of the ref", () => {
  const story = storyOf([[poseRef(1), "office"]]);
  const settled = settledFor(story, library, 1);
  const moved = storyOf([
    ["formal", "office"],
    [poseRef(1), "office"],
  ]);
  const shown = select({story: moved, library, settled});

  assert.equal(shown.state.kind, "pending");
  assert.deepEqual(shown.sources, {[poseRef(1)]: {kind: "url", url: "blob:s/1"}});
});

test("a Story over the ref cap is over-budget at once, without a pending Player", () => {
  const refs = Array.from({length: 65}, (_, index) => poseRef(index + 1));
  const story = storyOf(refs.map((ref) => [ref, "office"]));
  const withoutSettled = select({story, library, settled: null});
  const opening = select({story, library: null, settled: null});

  for (const shown of [withoutSettled, opening]) {
    assert.equal(shown.state.kind, "over-budget");
    assert.deepEqual(shown.state.budget.exceeded, ["refs"]);
    assert.equal(shown.sources, undefined);
  }
});
