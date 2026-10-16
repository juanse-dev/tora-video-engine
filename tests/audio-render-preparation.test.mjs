import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {describe, it} from "node:test";
import {inspectAudio, audioMimeTypeFor} from "../src/localAssets/audioInspection.ts";
import {sha256Hex} from "../src/localAssets/hash.ts";
import {buildLocalAssetRef} from "../src/localAssets/refs.ts";
import {AudioDecodeCache} from "../src/web/assetLibrary/audioDecodeCache.ts";
import {IntegrityCache} from "../src/web/assetLibrary/integrity.ts";
import {
  AUDIO_CHANGED_MESSAGE,
  CHECKING_AUDIO_MESSAGE,
  createAudioRenderPreparation,
} from "../src/web/audioRenderPreparation.ts";
import {startBrowserRenderTransaction} from "../src/web/browserRender.ts";
import {
  createLocalAssetRenderPreparation,
  resolveStoryLocalAssets,
} from "../src/web/localAssetState.ts";
import {buildWav, fixtureBytes} from "./helpers/audioBytes.mjs";
import {
  createMemoryAssetStore,
  createMemoryLockManager,
} from "./helpers/memoryAssetStore.mjs";

const scene = (overrides = {}) => ({
  type: "dialogue",
  pose: "formal",
  background: "office",
  text: "Hi",
  duration: 3,
  ...overrides,
});
const dingStory = {title: "Ding", scenes: [scene({sfx: {src: "ding"}})]};
const row = (label) => ({label, originalFilename: `${label}.wav`, createdAt: "2026-01-01T00:00:00.000Z"});
const signal = () => new AbortController().signal;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A fake object-URL API that records what the render created and revoked. */
const fakeUrls = () => {
  const created = [];
  const revoked = [];

  return {
    created,
    revoked,
    deps: {
      createObjectUrl: (blob) => {
        created.push(blob);

        return `blob:render/${created.length}`;
      },
      revokeObjectUrl: (url) => revoked.push(url),
    },
  };
};

/** The real bundled ding.wav as the store would hold it once `ready`. */
const readyDing = async () => ({
  kind: "ready",
  blob: new Blob([await readFile(new URL("../public/audio/sfx/ding.wav", import.meta.url))]),
});

/** A fake pool + fake local preparation for a Story with no verified payloads. */
const fakeLocal = (sources = {}) => {
  const events = [];

  return {
    events,
    prepare: async () => ({
      ok: true,
      localAssetSources: Object.freeze({...sources}),
      release: () => events.push("local-release"),
    }),
  };
};

const prepareFor = (story, options = {}) => {
  const urls = options.urls ?? fakeUrls();
  const decodeCache = options.decodeCache ?? new AudioDecodeCache(async () => ({decodedSeconds: 2.2}));

  return {
    urls,
    decodeCache,
    run: createAudioRenderPreparation({
      story,
      resolved: options.resolved ?? null,
      prepareLocal: options.prepareLocal ?? null,
      getBundledStates: () => new Map(Object.entries(options.bundled ?? {})),
      store: options.store ?? null,
      decodeCache,
      onStatus: options.onStatus,
      deps: urls.deps,
    }),
  };
};

describe("bundled audio in the render preparation", () => {
  it("freezes a render-owned object URL of the store's blob under the bundled id and revokes it with the lease", async () => {
    const ding = await readyDing();
    const local = fakeLocal();
    const {urls, run} = prepareFor(dingStory, {bundled: {ding}, prepareLocal: local.prepare});
    const result = await run(signal());

    assert.equal(result.ok, true);
    assert.deepEqual(result.audioSources, {ding: {kind: "url", url: "blob:render/1"}});
    assert.equal(Object.isFrozen(result.audioSources), true);
    assert.equal(urls.created[0], ding.blob);
    assert.deepEqual(result.localAudioDurations, {});

    result.release();
    result.release();
    assert.deepEqual(urls.revoked, ["blob:render/1"]);
    assert.deepEqual(local.events, ["local-release"]);
  });

  it("does not decode the bundled blob again: the store's ready state is the decode", async () => {
    let decodes = 0;
    const decodeCache = new AudioDecodeCache(async () => {
      decodes += 1;

      return {decodedSeconds: 1.2};
    });
    const {run} = prepareFor(dingStory, {bundled: {ding: await readyDing()}, decodeCache});

    assert.equal((await run(signal())).ok, true);
    assert.equal(decodes, 0);
  });

  for (const [title, state] of [
    ["absent", undefined],
    ["loading", {kind: "loading"}],
    ["retrying", {kind: "retrying", attempt: 1}],
    ["fetch-failed", {kind: "fetch-failed", message: "Network"}],
    ["unusable", {kind: "unusable", message: "bad bytes"}],
    ["ready without a blob", {kind: "ready"}],
  ]) {
    it(`returns assets-changed without creating a URL when the bundled id is ${title} at the click, releasing the local lease`, async () => {
      const local = fakeLocal();
      const {urls, run} = prepareFor(dingStory, {
        bundled: state === undefined ? {} : {ding: state},
        prepareLocal: local.prepare,
      });
      const result = await run(signal());

      assert.deepEqual(result, {ok: false, message: AUDIO_CHANGED_MESSAGE});
      assert.equal(AUDIO_CHANGED_MESSAGE, "Audio changed while preparing the render. Try again.");
      assert.equal(urls.created.length, 0);
      assert.deepEqual(local.events, ["local-release"]);
    });
  }

  it("rejects a bundled blob that is not the catalog length, naming the sound by its label", async () => {
    const local = fakeLocal();
    const {urls, run} = prepareFor(dingStory, {
      bundled: {ding: {kind: "ready", blob: new Blob([buildWav({seconds: 5})])}},
      prepareLocal: local.prepare,
    });

    await assert.rejects(run(signal()), /^Error: Audio file Ding cannot be used for rendering\.$/u);
    assert.deepEqual(urls.revoked, ["blob:render/1"]);
    assert.deepEqual(local.events, ["local-release"]);
  });

  it("rejects a bundled blob that is a video file", async () => {
    const {run} = prepareFor(dingStory, {
      bundled: {ding: {kind: "ready", blob: new Blob([fixtureBytes("with-video.mp4")])}},
    });

    await assert.rejects(run(signal()), /Audio file Ding cannot be used for rendering\./u);
  });

  it("the frozen-map re-check refuses a source map that lost a local source, before any preflight", async () => {
    let decodes = 0;
    const voice = `local:audio:sha256:${"b".repeat(64)}`;
    const story = {title: "Voice", scenes: [scene({voice: {src: voice}})]};
    const local = fakeLocal({});
    const decodeCache = new AudioDecodeCache(async () => {
      decodes += 1;

      return {decodedSeconds: 2.2};
    });
    const {run} = prepareFor(story, {prepareLocal: local.prepare, decodeCache});
    const result = await run(signal());

    assert.deepEqual(result, {ok: false, message: AUDIO_CHANGED_MESSAGE});
    assert.equal(decodes, 0);
    assert.deepEqual(local.events, ["local-release"]);
  });

  it("says what the wait is, once, before the preflight and not when the sources changed", async () => {
    const statuses = [];
    const ready = prepareFor(dingStory, {
      bundled: {ding: await readyDing()},
      onStatus: (message) => statuses.push(message),
    });

    assert.equal((await ready.run(signal())).ok, true);
    assert.deepEqual(statuses, ["Checking audio…"]);
    assert.equal(CHECKING_AUDIO_MESSAGE, "Checking audio…");

    const changed = prepareFor(dingStory, {
      bundled: {},
      onStatus: (message) => statuses.push(message),
    });

    assert.equal((await changed.run(signal())).ok, false);
    assert.deepEqual(statuses, ["Checking audio…"]);
  });

  it("a Story that is longer than the browser can render with its audio gets the length sentence, not the 'changed' one", async () => {
    const long = {title: "Long", scenes: [scene({duration: 3601, sfx: {src: "ding"}})]};
    const local = fakeLocal();
    const {urls, run} = prepareFor(long, {bundled: {ding: await readyDing()}, prepareLocal: local.prepare});

    assert.deepEqual(await run(signal()), {
      ok: false,
      message: "This Story is longer than 300 s with its voices (3601 s).",
    });
    assert.deepEqual(urls.revoked, ["blob:render/1"]);
    assert.deepEqual(local.events, ["local-release"]);
  });

  it("returns the local preparation's own failure unchanged", async () => {
    const failure = {ok: false, message: "Local assets changed while preparing the render. Try again."};
    const {run} = prepareFor(dingStory, {
      bundled: {ding: await readyDing()},
      prepareLocal: async () => failure,
    });

    assert.deepEqual(await run(signal()), failure);
  });
});

describe("local audio in the render preparation", () => {
  const seedVoice = async (store, name = "tone-440-2.2s.wav", label = "Voice take") => {
    const bytes = fixtureBytes(name);
    const digest = await sha256Hex(bytes);
    const inspected = await inspectAudio(bytes);

    assert.equal(inspected.ok, true);

    const {container, codec, durationSeconds, sampleRate, channels} = inspected.metadata;
    const ref = buildLocalAssetRef("audio", digest);

    store.setRaw("assets", ref, row(label));
    store.setRaw("payloadMeta", digest, {
      kind: "audio",
      mimeType: audioMimeTypeFor(container),
      byteSize: bytes.length,
      container,
      codec,
      durationSeconds,
      sampleRate,
      channels,
    });
    store.setRaw("blobs", digest, {blob: new Blob([bytes])});

    return {ref, digest, durationSeconds};
  };
  const setup = async (name, label) => {
    const store = createMemoryAssetStore();
    const voice = await seedVoice(store, name, label);
    const story = {
      title: "Voice and ding",
      scenes: [scene({voice: {src: voice.ref}, sfx: {src: "ding"}, duration: "auto"})],
    };
    const resolved = await resolveStoryLocalAssets(
      story,
      {kind: "ready", store},
      new IntegrityCache(),
    );
    const pool = {acquired: [], released: []};

    assert.equal(resolved.allReady, true);

    return {
      store,
      voice,
      story,
      resolved,
      pool,
      prepareLocal: createLocalAssetRenderPreparation({
        resolved,
        store,
        locks: createMemoryLockManager(),
        pool: {
          acquire: (digest) => {
            pool.acquired.push(digest);

            return `blob:lease/${digest.slice(0, 4)}`;
          },
          release: (digest) => pool.released.push(digest),
        },
      }),
    };
  };

  it("freezes lease URLs for the voice and render-owned URLs for the bundled sfx, with the verified duration", async () => {
    const {story, voice, resolved, store, prepareLocal, pool} = await setup();
    const prepared = prepareFor(story, {
      resolved,
      store,
      prepareLocal,
      bundled: {ding: await readyDing()},
    });
    const result = await prepared.run(signal());

    assert.equal(result.ok, true);
    assert.deepEqual(result.audioSources, {
      [voice.ref]: {kind: "url", url: `blob:lease/${voice.digest.slice(0, 4)}`},
      ding: {kind: "url", url: "blob:render/1"},
    });
    assert.deepEqual(result.localAudioDurations, {[voice.ref]: 2.2});
    assert.deepEqual(Object.keys(result.localAssetSources), [voice.ref]);

    result.release();
    assert.deepEqual(pool.released, [voice.digest]);
    assert.deepEqual(prepared.urls.revoked, ["blob:render/1"]);
  });

  it("decodes each local source once per session: a second render of the same Story does not decode", async () => {
    const {story, resolved, store, prepareLocal} = await setup();
    const decodeCache = new AudioDecodeCache(
      (() => {
        let calls = 0;

        return async () => {
          calls += 1;
          assert.equal(calls, 1, "decoded twice");

          return {decodedSeconds: 2.2};
        };
      })(),
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await prepareFor(story, {
        resolved,
        store,
        prepareLocal,
        decodeCache,
        bundled: {ding: await readyDing()},
      }).run(signal());

      assert.equal(result.ok, true);
      result.release();
    }
  });

  it("rejects a voice whose session decode fails, naming it by its library label, and releases everything", async () => {
    const {story, resolved, store, prepareLocal, pool} = await setup();
    const decodeCache = new AudioDecodeCache(async () => {
      throw new Error("This audio file could not be decoded.");
    });
    const prepared = prepareFor(story, {
      resolved,
      store,
      prepareLocal,
      decodeCache,
      bundled: {ding: await readyDing()},
    });

    await assert.rejects(prepared.run(signal()), /^Error: Audio file Voice take cannot be used for rendering\.$/u);
    assert.equal(pool.released.length, 1);
    assert.deepEqual(prepared.urls.revoked, ["blob:render/1"]);
  });

  it("rejects a truncated decode (0.3 s short) and accepts one 0.2 s short", async () => {
    for (const [decoded, accepted] of [[1.9, false], [2.0, true]]) {
      const {story, resolved, store, prepareLocal} = await setup();
      const decodeCache = new AudioDecodeCache(async () => ({decodedSeconds: decoded}));
      const run = prepareFor(story, {
        resolved,
        store,
        prepareLocal,
        decodeCache,
        bundled: {ding: await readyDing()},
      }).run(signal());

      if (accepted) {
        assert.equal((await run).ok, true);
      } else {
        await assert.rejects(run, /Audio file Voice take cannot be used for rendering\./u);
      }
    }
  });

  it("aborting during the decode rejects with the abort and releases everything", async () => {
    const {story, resolved, store, prepareLocal, pool} = await setup();
    const controller = new AbortController();
    // A decode that never settles, with inert timers: the cache's 30 s timeout is
    // not armed for real, so the test does not keep the process (or npm test) waiting.
    const decodeCache = new AudioDecodeCache(() => new Promise(() => undefined), {
      timers: {setTimeout: () => 0, clearTimeout: () => undefined},
    });
    const prepared = prepareFor(story, {
      resolved,
      store,
      prepareLocal,
      decodeCache,
      bundled: {ding: await readyDing()},
    });
    const running = prepared.run(controller.signal);

    await tick();
    await tick();
    controller.abort();
    await assert.rejects(running, {name: "AbortError"});
    assert.equal(pool.released.length, 1);
    assert.deepEqual(prepared.urls.revoked, ["blob:render/1"]);
  });
});

describe("a failed audio preflight inside the render transaction", () => {
  it("fails the render before any OPFS cleanup and releases the render lock", async () => {
    const calls = [];
    const decodeCache = new AudioDecodeCache(async () => ({decodedSeconds: 0}));
    const store = createMemoryAssetStore();
    const bytes = fixtureBytes("tone-440-2.2s.wav");
    const digest = await sha256Hex(bytes);
    const ref = buildLocalAssetRef("audio", digest);
    const inspected = await inspectAudio(bytes);
    const story = {title: "Voice", scenes: [scene({voice: {src: ref}})]};

    store.setRaw("assets", ref, row("Voice take"));
    store.setRaw("payloadMeta", digest, {
      kind: "audio",
      mimeType: "audio/wav",
      byteSize: bytes.length,
      container: inspected.metadata.container,
      codec: inspected.metadata.codec,
      durationSeconds: inspected.metadata.durationSeconds,
      sampleRate: inspected.metadata.sampleRate,
      channels: inspected.metadata.channels,
    });
    store.setRaw("blobs", digest, {blob: new Blob([bytes])});

    const resolved = await resolveStoryLocalAssets(
      story,
      {kind: "ready", store},
      new IntegrityCache(),
    );
    const outcome = await startBrowserRenderTransaction(story, {
      signal: signal(),
      checkCapability: async () => ({kind: "ready"}),
      acquireLock: async () => ({mode: "owner", release: () => calls.push("lock-release")}),
      cleanup: async () => {
        calls.push("cleanup");

        return {ok: true, attempts: 1};
      },
      renderStory: async () => {
        calls.push("render");
      },
      prepareLocalAssets: createAudioRenderPreparation({
        story,
        resolved,
        prepareLocal: createLocalAssetRenderPreparation({
          resolved,
          store,
          locks: createMemoryLockManager(),
          pool: {acquire: () => "blob:lease/x", release: () => calls.push("lease-release")},
        }),
        getBundledStates: () => new Map(),
        store,
        decodeCache,
      }),
    });

    assert.equal(outcome.kind, "failure");
    assert.match(outcome.error.message, /^Audio file Voice take cannot be used for rendering\.$/u);
    assert.deepEqual(calls, ["lease-release", "lock-release"]);
  });
});
