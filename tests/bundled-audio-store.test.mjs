import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {bundledAudioCatalog} from "../src/audio/catalog.ts";
import {AudioDecodeError} from "../src/web/assetLibrary/audioPeaks.ts";
import {
  BUNDLED_AUDIO_FETCH_FAILED_MESSAGE,
  BUNDLED_AUDIO_NOT_SUPPLIED_MESSAGE,
  BUNDLED_AUDIO_RETRY_DELAYS_MS,
  audioSourceForBundledState,
  createBundledAudioStore,
  getBundledAudioStates,
  requestBundledAudio,
  retryBundledAudio,
  storyBundledAudio,
  subscribeBundledAudio,
  useBundledAudioStates,
} from "../src/web/audio/bundledAudio.ts";

const METADATA = {container: "wave", codec: "pcm", durationSeconds: 1.2, sampleRate: 48_000, channels: 2};
const SUMMARY = {decodedSeconds: 1.2, peaks: Uint8Array.from([10, 255, 30]), peaksPerSecond: 2.5};
const flush = async () => {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
};

/** A manual clock: timers only run when the test fires them. */
const makeClock = () => {
  const timers = [];

  return {
    timers,
    setTimer: (callback, delayMs) => {
      const timer = {callback, delayMs, cleared: false, fired: false};

      timers.push(timer);

      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
    pending: () => timers.filter((timer) => !timer.cleared && !timer.fired),
    /** Fires the single pending timer. */
    fire: async () => {
      const [timer] = timers.filter((candidate) => !candidate.cleared && !candidate.fired);

      assert.ok(timer, "a timer is pending");
      timer.fired = true;
      timer.callback();
      await flush();

      return timer.delayMs;
    },
  };
};

/**
 * `behaviours[n]` decides the n-th fetch: "ok", "network" (rejects), "http"
 * (a 503 response), "body" (the body read rejects), or {hold: true} (stays
 * pending until released or aborted).
 */
const makeFetch = (behaviours) => {
  const calls = [];
  const fetch = (url, {signal}) => {
    const behaviour = behaviours[calls.length] ?? behaviours.at(-1);
    const call = {url, signal, release: () => {}};

    calls.push(call);

    if (behaviour === "network") {
      return Promise.reject(new TypeError("Failed to fetch"));
    }

    if (behaviour === "http") {
      return Promise.resolve({ok: false, blob: async () => new Blob([])});
    }

    if (behaviour === "body") {
      return Promise.resolve({ok: true, blob: () => Promise.reject(new TypeError("body"))});
    }

    const respond = () => ({ok: true, blob: async () => new Blob([`bytes ${calls.length}`])});

    if (behaviour === "ok") {
      return Promise.resolve(respond());
    }

    return new Promise((resolve, reject) => {
      call.release = (response = respond()) => resolve(response);
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  };

  return {fetch, calls};
};

const makeStore = (overrides = {}) => {
  const clock = makeClock();
  const log = {inspect: 0, decode: 0, objectUrls: 0};
  const remote = makeFetch(overrides.behaviours ?? ["ok"]);
  const store = createBundledAudioStore({
    fetch: remote.fetch,
    inspect: async () => {
      log.inspect += 1;

      return overrides.inspect?.() ?? {ok: true, metadata: METADATA};
    },
    decode: async (_blob, _metadata, signal) => {
      log.decode += 1;

      return overrides.decode?.(signal) ?? SUMMARY;
    },
    fileUrl: (file) => `/${file}`,
    createObjectUrl: (blob) => {
      log.objectUrls += 1;

      return `blob:test/${log.objectUrls}`;
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    catalog: bundledAudioCatalog,
    retryDelaysMs: BUNDLED_AUDIO_RETRY_DELAYS_MS,
  });
  const snapshots = [];

  store.subscribe(() => snapshots.push(store.getStates()));

  return {store, clock, log, remote, snapshots};
};

const kinds = (store, id) => store.getStates().get(id)?.kind;

describe("the bundled-audio store: checking an id", () => {
  it("fetches the catalog file once, inspects, decodes and ends ready with peaks, the Blob and ONE object URL", async () => {
    const {store, remote, log} = makeStore();

    store.request(["ding"]);
    assert.equal(kinds(store, "ding"), "loading");
    await flush();

    const state = store.getStates().get("ding");

    assert.equal(state.kind, "ready");
    assert.deepEqual(state.peaks, {peaksPerSecond: 2.5, peaks: Uint8Array.from([10, 255, 30])});
    assert.ok(state.blob instanceof Blob);
    assert.equal(state.url, "blob:test/1");
    assert.deepEqual(remote.calls.map((call) => call.url), ["/audio/sfx/ding.wav"]);
    assert.equal(log.objectUrls, 1);

    store.request(["ding"]);
    store.request([]);
    store.request(["ding"]);
    await flush();
    assert.equal(store.getStates().get("ding"), state);
    assert.equal(remote.calls.length, 1);
    assert.equal(log.objectUrls, 1);
  });

  it("two scenes (or two requests) using one id cause one fetch", async () => {
    const {store, remote} = makeStore();

    store.request(["ding", "ding", "pop"]);
    store.request(["pop", "ding"]);
    await flush();

    assert.deepEqual(
      remote.calls.map((call) => call.url).sort(),
      ["/audio/sfx/ding.wav", "/audio/sfx/pop.wav"],
    );
  });

  it("an id whose catalog file is null is unusable at once, without any fetch", async () => {
    const {store, remote} = makeStore();

    store.request(["calm-loop"]);
    assert.deepEqual(store.getStates().get("calm-loop"), {
      kind: "unusable",
      message: BUNDLED_AUDIO_NOT_SUPPLIED_MESSAGE,
    });
    await flush();
    assert.equal(remote.calls.length, 0);
  });
});

describe("the bundled-audio store: transitions publish", () => {
  it("every transition publishes a NEW map, a request that changes nothing publishes nothing", async () => {
    const {store, snapshots} = makeStore();
    const initial = store.getStates();

    store.request([]);
    assert.equal(snapshots.length, 0);
    assert.equal(store.getStates(), initial);

    store.request(["ding"]);
    await flush();
    assert.equal(snapshots.length, 2); // loading, ready
    assert.equal(new Set([initial, ...snapshots]).size, 3);
    assert.equal(snapshots[0].get("ding").kind, "loading");
    assert.equal(snapshots[1].get("ding").kind, "ready");

    // Nothing transitions: the same object, no notification.
    store.request(["ding"]);
    await flush();
    assert.equal(snapshots.length, 2);
    assert.equal(store.getStates(), snapshots[1]);
  });

  it("a map that was published never changes afterwards", async () => {
    const {store, snapshots} = makeStore();

    store.request(["ding", "pop"]);
    await flush();

    assert.equal(snapshots[0].has("pop"), false);
    assert.equal(snapshots[0].get("ding").kind, "loading");
  });

  it("unsubscribe stops the notifications", async () => {
    const {store} = makeStore();
    const seen = [];
    const unsubscribe = store.subscribe(() => seen.push(1));

    store.request(["ding"]);
    await flush();
    const before = seen.length;

    unsubscribe();
    store.request(["ding", "pop"]);
    await flush();
    assert.equal(seen.length, before);
  });
});

describe("the bundled-audio store: network failures are transient", () => {
  it("retries after 1 s, 2 s and 4 s (retrying 1, 2, 3), then fetch-failed, and Retry goes loading then ready", async () => {
    const {store, clock, remote, snapshots} = makeStore({behaviours: ["network", "network", "network", "network", "ok"]});

    store.request(["ding"]);
    await flush();
    assert.deepEqual(store.getStates().get("ding"), {kind: "retrying", attempt: 1});
    assert.equal(clock.pending()[0].delayMs, 1_000);

    assert.equal(await clock.fire(), 1_000);
    assert.deepEqual(store.getStates().get("ding"), {kind: "retrying", attempt: 2});
    assert.equal(clock.pending()[0].delayMs, 2_000);

    assert.equal(await clock.fire(), 2_000);
    assert.deepEqual(store.getStates().get("ding"), {kind: "retrying", attempt: 3});
    assert.equal(clock.pending()[0].delayMs, 4_000);

    assert.equal(await clock.fire(), 4_000);
    assert.deepEqual(store.getStates().get("ding"), {kind: "fetch-failed", message: BUNDLED_AUDIO_FETCH_FAILED_MESSAGE});
    assert.equal(remote.calls.length, 4);
    assert.equal(clock.pending().length, 0);
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.get("ding").kind + (snapshot.get("ding").attempt ?? "")),
      ["loading", "retrying1", "retrying2", "retrying3", "fetch-failed"],
    );

    store.retry("ding");
    assert.equal(kinds(store, "ding"), "loading");
    await flush();
    assert.equal(kinds(store, "ding"), "ready");
    assert.equal(remote.calls.length, 5);
  });

  it("a retry that succeeds publishes ready like a first success, without any other interaction", async () => {
    const {store, clock, log} = makeStore({behaviours: ["network", "ok"]});

    store.request(["ding"]);
    await flush();
    assert.equal(kinds(store, "ding"), "retrying");
    await clock.fire();
    assert.equal(kinds(store, "ding"), "ready");
    assert.equal(store.getStates().get("ding").url, "blob:test/1");
    assert.equal(log.objectUrls, 1);
    assert.equal(clock.pending().length, 0);
  });

  it("an HTTP error and a body that fails to read are transient too", async () => {
    for (const behaviour of ["http", "body"]) {
      const {store, clock} = makeStore({behaviours: [behaviour, "ok"]});

      store.request(["ding"]);
      await flush();
      assert.deepEqual(store.getStates().get("ding"), {kind: "retrying", attempt: 1}, behaviour);
      await clock.fire();
      assert.equal(kinds(store, "ding"), "ready", behaviour);
    }
  });

  it("Retry does nothing in any other state", async () => {
    const {store, remote} = makeStore({behaviours: ["ok"]});

    store.retry("ding");
    store.request(["ding", "calm-loop"]);
    await flush();
    store.retry("ding");
    store.retry("calm-loop");
    store.retry("pop");
    await flush();
    assert.equal(remote.calls.length, 1);
    assert.equal(kinds(store, "ding"), "ready");
    assert.equal(kinds(store, "calm-loop"), "unusable");
    assert.equal(kinds(store, "pop"), undefined);
  });
});

describe("the bundled-audio store: terminal failures are memoized", () => {
  const cases = {
    "an inspection that rejects the file": {inspect: () => ({ok: false, message: "Video files are not supported. Use an audio file."}), message: "Video files are not supported. Use an audio file."},
    "an inspection that throws": {inspect: () => { throw new Error("boom"); }, message: "This audio file could not be decoded."},
    "a decode error": {decode: () => { throw new AudioDecodeError(); }, message: "This audio file could not be decoded."},
    "a truncated decode": {decode: () => ({...SUMMARY, decodedSeconds: 0.5}), message: "This audio file looks truncated."},
    "a decode that produced nothing": {decode: () => ({...SUMMARY, decodedSeconds: 0}), message: "This audio file looks truncated."},
  };

  for (const [name, {message, ...overrides}] of Object.entries(cases)) {
    it(`${name} ends unusable with its message and is never fetched, retried or re-checked again`, async () => {
      const {store, clock, remote, log} = makeStore(overrides);

      store.request(["ding"]);
      await flush();

      const state = store.getStates().get("ding");

      assert.deepEqual(state, {kind: "unusable", message});
      assert.equal(clock.timers.length, 0);

      store.retry("ding");
      store.request([]);
      store.request(["ding"]);
      store.request(["ding", "pop"]);
      await flush();
      assert.equal(store.getStates().get("ding"), state);
      assert.equal(remote.calls.filter((call) => call.url.endsWith("ding.wav")).length, 1);
      assert.equal(log.objectUrls, 0, "an unusable id never gets an object URL");
    });
  }
});

describe("the bundled-audio store: ids that are no longer requested", () => {
  it("abort the in-flight fetch, forget the state and publish nothing for the stale result", async () => {
    const {store, remote, snapshots} = makeStore({behaviours: [{hold: true}, "ok"]});

    store.request(["ding"]);
    await flush();
    assert.equal(kinds(store, "ding"), "loading");

    store.request([]);
    assert.equal(remote.calls[0].signal.aborted, true);
    assert.equal(store.getStates().has("ding"), false);

    const count = snapshots.length;

    remote.calls[0].release();
    await flush();
    assert.equal(snapshots.length, count);
    assert.equal(store.getStates().has("ding"), false);

    // A later request starts it afresh.
    store.request(["ding"]);
    await flush();
    assert.equal(remote.calls.length, 2);
    assert.equal(kinds(store, "ding"), "ready");
  });

  it("clear the pending retry timer and a retry that would have run never fetches", async () => {
    const {store, clock, remote} = makeStore({behaviours: ["network", "ok"]});

    store.request(["ding"]);
    await flush();
    assert.equal(clock.pending().length, 1);

    store.request(["pop"]);
    assert.equal(clock.pending().length, 0);
    assert.equal(clock.timers[0].cleared, true);
    assert.equal(store.getStates().has("ding"), false);
    await flush();
    assert.equal(remote.calls.filter((call) => call.url.endsWith("ding.wav")).length, 1);
  });

  it("forget a fetch-failed id, so showing it again retries by itself", async () => {
    const {store, clock, remote} = makeStore({behaviours: ["network", "network", "network", "network", "ok"]});

    store.request(["ding"]);
    await flush();
    await clock.fire();
    await clock.fire();
    await clock.fire();
    assert.equal(kinds(store, "ding"), "fetch-failed");

    store.request([]);
    assert.equal(store.getStates().has("ding"), false);
    store.request(["ding"]);
    await flush();
    assert.equal(kinds(store, "ding"), "ready");
    assert.equal(remote.calls.length, 5);
  });

  it("keep ready and unusable ids for the page session", async () => {
    const {store, remote} = makeStore();

    store.request(["ding", "calm-loop"]);
    await flush();

    const ready = store.getStates().get("ding");

    store.request([]);
    assert.equal(store.getStates().get("ding"), ready);
    assert.equal(kinds(store, "calm-loop"), "unusable");
    store.request(["ding"]);
    assert.equal(remote.calls.length, 1);
  });

  it("abort the decode of an id that was dropped while decoding, and publish nothing for it", async () => {
    let decodeSignal;
    let finish = () => {};
    const {store, snapshots} = makeStore({
      decode: (signal) => {
        decodeSignal = signal;

        return new Promise((resolve) => {
          finish = () => resolve(SUMMARY);
        });
      },
    });

    store.request(["ding"]);
    await flush();
    assert.equal(kinds(store, "ding"), "loading");
    store.request([]);
    assert.equal(decodeSignal.aborted, true);

    const count = snapshots.length;

    finish();
    await flush();
    assert.equal(snapshots.length, count);
    assert.equal(store.getStates().has("ding"), false);
  });
});

describe("the page-level API (AUDIO-005 consumes it as is)", () => {
  it("exposes request, retry, subscribe, the states snapshot and the hook", () => {
    for (const member of [requestBundledAudio, retryBundledAudio, subscribeBundledAudio, getBundledAudioStates, useBundledAudioStates]) {
      assert.equal(typeof member, "function");
    }

    const states = getBundledAudioStates();

    assert.equal(states instanceof Map, true);
    assert.equal(states.size, 0);
    assert.equal(getBundledAudioStates(), states);

    const unsubscribe = subscribeBundledAudio(() => {});

    assert.equal(typeof unsubscribe, "function");
    unsubscribe();
  });
});

describe("what the Player and the story helpers take from the store", () => {
  it("maps each state to the Player's source: pending, url, unavailable, or no entry", () => {
    const blob = new Blob(["x"]);

    assert.equal(audioSourceForBundledState(undefined), undefined);
    assert.deepEqual(audioSourceForBundledState({kind: "loading"}), {kind: "pending"});
    assert.deepEqual(audioSourceForBundledState({kind: "retrying", attempt: 2}), {kind: "pending"});
    assert.deepEqual(audioSourceForBundledState({kind: "fetch-failed", message: "x"}), {kind: "pending"});
    assert.deepEqual(audioSourceForBundledState({kind: "unusable", message: "x"}), {kind: "unavailable"});
    assert.deepEqual(
      audioSourceForBundledState({kind: "ready", peaks: {peaksPerSecond: 1, peaks: new Uint8Array(1)}, blob, url: "blob:a"}),
      {kind: "url", url: "blob:a"},
    );
  });

  it("lists only the bundled ids of a Story", () => {
    const local = `local:audio:sha256:${"1".repeat(64)}`;
    const story = {
      title: "T",
      music: {src: "calm-loop"},
      scenes: [
        {type: "intro", pose: "formal", background: "office", text: "A", duration: 3, sfx: {src: "ding"}, voice: {src: local}},
        {type: "intro", pose: "formal", background: "office", text: "B", duration: 3, sfx: {src: "ding"}},
      ],
    };

    assert.deepEqual(storyBundledAudio(story), ["calm-loop", "ding"]);
    assert.deepEqual(storyBundledAudio({title: "T", scenes: [story.scenes[0]].map((scene) => ({...scene, sfx: undefined, voice: undefined}))}), []);
  });
});
