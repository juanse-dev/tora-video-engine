import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {sha256Hex} from "../src/localAssets/hash.ts";
import {buildLocalAssetRef} from "../src/localAssets/refs.ts";
import {importLocalAsset} from "../src/web/assetLibrary/importAsset.ts";
import {IntegrityCache} from "../src/web/assetLibrary/integrity.ts";
import {
  AUDIO_PREVIEW_FAILED_MESSAGE,
  createPreviewPlayback,
} from "../src/web/audio/previewPlayback.ts";
import {acquireAudioPreviewUrl} from "../src/web/audio/previewSource.ts";
import {fixtureBytes} from "./helpers/audioBytes.mjs";
import {createMemoryAssetStore, createMemoryLockManager} from "./helpers/memoryAssetStore.mjs";

const digestOf = (n) => n.toString(16).padStart(64, "0");
const refOf = (n) => buildLocalAssetRef("audio", digestOf(n));

/** A fake element that records what the coordinator does with it. */
const makeAudio = (log, {playRejects = false, primerRejects = false} = {}) => {
  const listeners = {};
  const audio = {
    src: "",
    listeners,
    play: async () => {
      log.push(`play ${audio.src}`);

      if (primerRejects && audio.src.startsWith("data:")) {
        throw new DOMException("interrupted", "AbortError");
      }

      if (playRejects) {
        throw new DOMException("blocked", "NotAllowedError");
      }
    },
    pause: () => log.push("pause"),
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
  };

  return audio;
};

const makeLease = (ref, leases) => {
  const lease = {
    url: `blob:${ref.slice(-4)}`,
    released: 0,
    release() {
      lease.released += 1;
    },
  };

  leases.push(lease);

  return lease;
};

const harness = (options = {}) => {
  const log = [];
  const created = [];
  const leases = [];
  const preview = createPreviewPlayback({
    createAudio: () => {
      const audio = makeAudio(log, options);

      created.push(audio);

      return audio;
    },
  });
  const acquireFor = async (ref) => {
    log.push(`acquire ${ref.slice(-4)}`);

    return makeLease(ref, leases);
  };

  preview.setPlayerPause(() => log.push("player.pause"));

  return {preview, log, created, leases, acquireFor};
};

describe("the page's audio preview", () => {
  it("Play pauses the Player first, loads the verified URL and plays it", async () => {
    const {preview, log, acquireFor} = harness();
    const states = [];

    preview.subscribe(() => states.push(preview.getState().kind));
    await preview.toggle(refOf(1), acquireFor);

    assert.deepEqual(
      log
        .filter((entry) => entry !== "pause")
        .map((entry) => (entry.startsWith("play data:") ? "play primer" : entry)),
      ["player.pause", "play primer", "acquire 0001", "play blob:0001"],
    );
    assert.deepEqual(states, ["loading", "playing"]);
    assert.deepEqual(preview.getState(), {kind: "playing", ref: refOf(1)});
  });

  it("primes the element synchronously inside the click, before the stored bytes are verified (Safari plays only inside the gesture)", async () => {
    const {preview, log, created, leases} = harness();
    let finish = () => {};
    const pending = preview.toggle(
      refOf(1),
      (ref) =>
        new Promise((resolve) => {
          log.push("acquire called");
          finish = () => resolve(makeLease(ref, leases));
        }),
    );

    // Nothing has been awaited yet: the primer already played, the real sound has not.
    assert.equal(created.length, 1);
    assert.match(created[0].src, /^data:audio\/wav;base64,UklGR/u);
    assert.deepEqual(
      log.filter((entry) => entry.startsWith("play ")).map((entry) => entry.slice(0, 15)),
      ["play data:audio"],
    );
    assert.ok(log.indexOf("acquire called") > log.findIndex((entry) => entry.startsWith("play data:")));
    assert.equal(preview.getState().kind, "loading");

    finish();
    await pending;
    assert.equal(created[0].src, "blob:0001");
    assert.equal(preview.getState().kind, "playing");
  });

  it("Stop or another Play while the primer plays still wins: the late URL is never played", async () => {
    const stopped = harness();
    let finishFirst = () => {};
    const first = stopped.preview.toggle(
      refOf(1),
      (ref) =>
        new Promise((resolve) => {
          finishFirst = () => resolve(makeLease(ref, stopped.leases));
        }),
    );

    stopped.preview.stop();
    finishFirst();
    await first;
    assert.deepEqual(stopped.preview.getState(), {kind: "idle"});
    assert.equal(stopped.leases[0].released, 1);
    assert.equal(stopped.log.some((entry) => entry.startsWith("play blob:")), false);
    assert.equal(stopped.log.at(-1), "pause");

    const replaced = harness();
    let finishOld = () => {};
    const old = replaced.preview.toggle(
      refOf(1),
      (ref) =>
        new Promise((resolve) => {
          finishOld = () => resolve(makeLease(ref, replaced.leases));
        }),
    );

    await replaced.preview.toggle(refOf(2), replaced.acquireFor);
    finishOld();
    await old;
    assert.deepEqual(replaced.preview.getState(), {kind: "playing", ref: refOf(2)});
    assert.deepEqual(
      replaced.log.filter((entry) => entry.startsWith("play blob:")),
      ["play blob:0002"],
    );
  });

  it("a rejected primer does not fail the preview: the real play() decides", async () => {
    const {preview, leases, acquireFor} = harness({primerRejects: true});

    await preview.toggle(refOf(1), acquireFor);
    assert.deepEqual(preview.getState(), {kind: "playing", ref: refOf(1)});
    assert.equal(leases[0].released, 0);
  });

  it("Stop on the playing sound pauses it, releases its URL and goes idle", async () => {
    const {preview, leases, created, acquireFor} = harness();

    await preview.toggle(refOf(1), acquireFor);
    await preview.toggle(refOf(1), acquireFor);

    assert.deepEqual(preview.getState(), {kind: "idle"});
    assert.equal(leases[0].released, 1);
    assert.equal(created.length, 1);
  });

  it("starting another sound stops the first: one preview at a time, one element", async () => {
    const {preview, log, leases, created, acquireFor} = harness();

    await preview.toggle(refOf(1), acquireFor);
    await preview.toggle(refOf(2), acquireFor);

    assert.deepEqual(preview.getState(), {kind: "playing", ref: refOf(2)});
    assert.equal(leases[0].released, 1);
    assert.equal(leases[1].released, 0);
    assert.equal(created.length, 1);
    assert.equal(log.filter((entry) => entry.startsWith("play blob:")).length, 2);
    assert.ok(log.indexOf("play blob:0002") > log.lastIndexOf("pause"));
  });

  it("the Player starting stops the preview", async () => {
    const {preview, leases, acquireFor} = harness();

    await preview.toggle(refOf(1), acquireFor);
    preview.playerStarted();

    assert.deepEqual(preview.getState(), {kind: "idle"});
    assert.equal(leases[0].released, 1);
  });

  it("stops by itself when the sound ends", async () => {
    const {preview, created, leases, acquireFor} = harness();

    await preview.toggle(refOf(1), acquireFor);
    created[0].listeners.ended();

    assert.deepEqual(preview.getState(), {kind: "idle"});
    assert.equal(leases[0].released, 1);
  });

  it("a failed load shows the failure for that sound and a later Play tries again", async () => {
    const {preview, acquireFor} = harness();
    let attempt = 0;
    const flaky = async (ref, signal) => {
      attempt += 1;

      if (attempt === 1) {
        throw new Error("The stored audio is missing or damaged.");
      }

      return acquireFor(ref, signal);
    };

    await preview.toggle(refOf(1), flaky);
    assert.deepEqual(preview.getState(), {
      kind: "failed",
      ref: refOf(1),
      message: AUDIO_PREVIEW_FAILED_MESSAGE,
    });

    await preview.toggle(refOf(1), flaky);
    assert.deepEqual(preview.getState(), {kind: "playing", ref: refOf(1)});
  });

  it("a blocked play() and an element error both fail and release the URL", async () => {
    const blocked = harness({playRejects: true});

    await blocked.preview.toggle(refOf(1), blocked.acquireFor);
    assert.equal(blocked.preview.getState().kind, "failed");
    assert.equal(blocked.leases[0].released, 1);

    const broken = harness();

    await broken.preview.toggle(refOf(1), broken.acquireFor);
    broken.created[0].listeners.error();
    assert.equal(broken.preview.getState().kind, "failed");
    assert.equal(broken.leases[0].released, 1);
  });

  it("a URL that arrives after Stop is released and never played", async () => {
    const {preview, log, leases} = harness();
    let finish = () => {};
    const slow = (ref) =>
      new Promise((resolve) => {
        finish = () => resolve(makeLease(ref, leases));
      });

    const first = preview.toggle(refOf(1), slow);

    assert.equal(preview.getState().kind, "loading");
    preview.stop();
    finish();
    await first;

    assert.deepEqual(preview.getState(), {kind: "idle"});
    assert.equal(leases[0].released, 1);
    assert.equal(log.some((entry) => entry.startsWith("play blob:")), false);
  });

  it("a URL that arrives after another Play started is released and never played", async () => {
    const {preview, log, leases, acquireFor} = harness();
    let finish = () => {};
    const slow = (ref) =>
      new Promise((resolve) => {
        finish = () => resolve(makeLease(ref, leases));
      });

    const first = preview.toggle(refOf(1), slow);

    await preview.toggle(refOf(2), acquireFor);
    finish();
    await first;

    assert.deepEqual(preview.getState(), {kind: "playing", ref: refOf(2)});
    assert.equal(leases.find((lease) => lease.url === "blob:0001").released, 1);
    assert.deepEqual(
      log.filter((entry) => entry.startsWith("play blob:")),
      ["play blob:0002"],
    );
  });

  it("Stop while loading aborts the acquire", async () => {
    const {preview} = harness();
    let signal;

    void preview.toggle(refOf(1), (_ref, abortSignal) => {
      signal = abortSignal;

      return new Promise(() => {});
    });

    assert.equal(preview.getState().kind, "loading");
    await preview.toggle(refOf(1), async () => assert.fail("Stop must not acquire"));
    assert.equal(signal.aborted, true);
    assert.deepEqual(preview.getState(), {kind: "idle"});
  });

  it("stopRef stops only the sound that is going away", async () => {
    const {preview, acquireFor} = harness();

    await preview.toggle(refOf(1), acquireFor);
    preview.stopRef(refOf(2));
    assert.equal(preview.getState().kind, "playing");
    preview.stopRef(refOf(1));
    assert.equal(preview.getState().kind, "idle");
  });

  it("publishes a new state object only on a change and stops notifying after unsubscribe", async () => {
    const {preview, acquireFor} = harness();
    const idle = preview.getState();
    let notified = 0;
    const unsubscribe = preview.subscribe(() => {
      notified += 1;
    });

    preview.stop();
    preview.playerStarted();
    assert.equal(preview.getState(), idle);
    assert.equal(notified, 0);

    await preview.toggle(refOf(1), acquireFor);

    const playing = preview.getState();

    assert.notEqual(playing, idle);
    assert.equal(preview.getState(), playing);

    const before = notified;

    unsubscribe();
    preview.stop();
    assert.equal(notified, before);
  });

  it("works without a Player", async () => {
    const {preview, acquireFor} = harness();

    preview.setPlayerPause(null);
    await preview.toggle(refOf(1), acquireFor);
    assert.equal(preview.getState().kind, "playing");
  });
});

describe("acquireAudioPreviewUrl", () => {
  const importFixture = async () => {
    const library = {
      store: createMemoryAssetStore(),
      locks: createMemoryLockManager(),
      channel: {post() {}},
    };
    const bytes = fixtureBytes("tone-440-2.2s.wav");

    await importLocalAsset(new File([bytes], "voice.wav"), "audio", library, {
      decodePeaks: async () => ({
        decodedSeconds: 2.2,
        peaks: Uint8Array.from([1]),
        peaksPerSecond: 50,
      }),
    });

    const digest = await sha256Hex(bytes);

    return {
      library,
      status: {kind: "ready", ...library},
      digest,
      ref: buildLocalAssetRef("audio", digest),
    };
  };
  const makePool = () => {
    const calls = [];

    return {
      calls,
      acquire: (digest, blob) => {
        calls.push(["acquire", digest, blob.type]);

        return `blob:${digest.slice(0, 4)}`;
      },
      release: (digest) => calls.push(["release", digest]),
    };
  };

  it("verifies the stored bytes and leases the pool's URL until released (once)", async () => {
    const {status, digest, ref} = await importFixture();
    const pool = makePool();
    const lease = await acquireAudioPreviewUrl({
      library: status,
      cache: new IntegrityCache(),
      pool,
      ref,
      signal: new AbortController().signal,
    });

    assert.equal(lease.url, `blob:${digest.slice(0, 4)}`);
    assert.deepEqual(pool.calls, [["acquire", digest, "audio/wav"]]);
    lease.release();
    lease.release();
    assert.deepEqual(pool.calls.at(-1), ["release", digest]);
    assert.equal(pool.calls.filter(([kind]) => kind === "release").length, 1);
  });

  it("refuses a library that is not ready, an absent copy and a damaged one", async () => {
    const {library, status, digest, ref} = await importFixture();
    const signal = new AbortController().signal;
    const attempt = (overrides) =>
      acquireAudioPreviewUrl({
        library: status,
        cache: new IntegrityCache(),
        pool: makePool(),
        ref,
        signal,
        ...overrides,
      });

    await assert.rejects(attempt({library: null}), /not available/u);
    await assert.rejects(
      attempt({library: {kind: "unavailable", message: "no"}}),
      /not available/u,
    );
    await assert.rejects(attempt({ref: refOf(77)}), /missing or damaged/u);

    library.store.setRaw("blobs", digest, {blob: new Blob([new Uint8Array(10)])});
    await assert.rejects(attempt({}), /missing or damaged/u);
  });

  it("a verification that finishes after an abort leases nothing", async () => {
    const {status, ref} = await importFixture();
    const pool = makePool();
    const controller = new AbortController();
    const pending = acquireAudioPreviewUrl({
      library: status,
      cache: new IntegrityCache(),
      pool,
      ref,
      signal: controller.signal,
    });

    controller.abort();
    await assert.rejects(pending);
    assert.deepEqual(pool.calls, []);
  });
});
