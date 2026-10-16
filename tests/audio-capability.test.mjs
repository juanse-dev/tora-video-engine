import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {describe, it} from "node:test";
import {exampleStory} from "../src/story/exampleStory.ts";
import {
  AUDIO_ENCODER_LOAD_MESSAGE,
  AUDIO_UNSUPPORTED_MESSAGE,
  checkBrowserRenderCapability,
  startBrowserRenderTransaction,
} from "../src/web/browserRender.ts";
import {storyHasAudio} from "../src/audio/storyAudio.ts";
import {createRenderCapabilityCache} from "../src/web/renderCapabilityCache.ts";

describe("AUDIO-005 browser capability with audio (D-13)", () => {
  const withLocks = {getLocks: () => ({query: async () => ({held: [], pending: []})})};
  const result = (overrides = {}) => ({
    canRender: true,
    issues: [],
    resolvedVideoCodec: "h264",
    resolvedAudioCodec: "aac",
    resolvedOutputTarget: "web-fs",
    ...overrides,
  });
  const audioIssue = {
    type: "audio-codec-unsupported",
    message: 'Audio codec "aac" cannot be encoded by this browser.',
    severity: "error",
  };
  const videoIssue = {
    type: "video-codec-unsupported",
    message: 'Video codec "h264" cannot be encoded by this browser',
    severity: "error",
  };

  it("asks for unmuted AAC at the output bitrate when the Story has audio", async () => {
    let seen = null;
    const capability = await checkBrowserRenderCapability({
      ...withLocks,
      hasAudio: true,
      canRender: async (options) => {
        seen = options;

        return result();
      },
    });

    assert.deepEqual(capability, {kind: "ready"});
    assert.deepEqual(seen, {
      container: "mp4",
      videoCodec: "h264",
      width: 1080,
      height: 1920,
      muted: false,
      audioCodec: "aac",
      audioBitrate: 128_000,
    });
  });

  it("keeps the v0.3 muted probe for a silent Story, with hasAudio absent or false", async () => {
    const seen = [];
    const canRender = async (options) => {
      seen.push(options);

      return result({resolvedAudioCodec: null});
    };

    await checkBrowserRenderCapability({...withLocks, canRender});
    await checkBrowserRenderCapability({...withLocks, canRender, hasAudio: false});

    const silent = {container: "mp4", videoCodec: "h264", width: 1080, height: 1920, muted: true};

    assert.deepEqual(seen, [silent, silent]);
  });

  it("blocks with the CLI sentence when only the audio codec cannot be encoded", async () => {
    const capability = await checkBrowserRenderCapability({
      ...withLocks,
      hasAudio: true,
      canRender: async () => result({canRender: false, issues: [audioIssue], resolvedAudioCodec: null}),
    });

    assert.deepEqual(capability, {
      kind: "audio-unsupported",
      message: "This browser cannot encode audio. Use the local CLI: npm run video -- <story.yaml>",
    });
    assert.equal(capability.message, AUDIO_UNSUPPORTED_MESSAGE);
  });

  it("reports a video problem as the usual unsupported message, even when the audio is also missing", async () => {
    const capability = await checkBrowserRenderCapability({
      ...withLocks,
      hasAudio: true,
      canRender: async () =>
        result({canRender: false, issues: [videoIssue, audioIssue], resolvedAudioCodec: null}),
    });

    assert.equal(capability.kind, "unsupported");
    assert.match(capability.message, /Video codec "h264" cannot be encoded/u);
  });

  it("never accepts another audio codec than AAC (AINV-9)", async () => {
    const capability = await checkBrowserRenderCapability({
      ...withLocks,
      hasAudio: true,
      canRender: async () => result({resolvedAudioCodec: "opus"}),
    });

    assert.equal(capability.kind, "audio-unsupported");
  });

  it("decides only after the probe settles, so the WASM encoder registration it awaits is part of the decision", async () => {
    let finishRegistration = () => undefined;
    const registered = new Promise((resolve) => {
      finishRegistration = resolve;
    });
    let decided = false;
    const pending = checkBrowserRenderCapability({
      ...withLocks,
      hasAudio: true,
      canRender: async () => {
        await registered;

        return result();
      },
    }).then((capability) => {
      decided = true;

      return capability;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(decided, false);
    finishRegistration();
    assert.deepEqual(await pending, {kind: "ready"});
  });

  it("a transaction with an unsupported audio capability does not take the render lock", async () => {
    let locked = false;
    const outcome = await startBrowserRenderTransaction(exampleStory, {
      signal: new AbortController().signal,
      checkCapability: async () => ({kind: "audio-unsupported", message: AUDIO_UNSUPPORTED_MESSAGE}),
      acquireLock: async () => {
        locked = true;

        return {mode: "owner", release: () => undefined};
      },
    });

    assert.deepEqual(outcome, {kind: "unsupported", message: AUDIO_UNSUPPORTED_MESSAGE});
    assert.equal(locked, false);
  });

  it("the transaction's own capability check asks for audio exactly when the Story has audio", async () => {
    const source = await readFile(new URL("../src/web/browserRender.ts", import.meta.url), "utf8");

    assert.match(source, /checkBrowserRenderCapability\(\{hasAudio: storyHasAudio\(story\)\}\)/u);
  });
});

describe("AUDIO-005 capability cache per storyHasAudio value", () => {
  it("probes each value at most once and never probes audio for a silent Story", async () => {
    const calls = [];
    const cache = createRenderCapabilityCache(async ({hasAudio}) => {
      calls.push(hasAudio);

      return hasAudio ? {kind: "audio-unsupported", message: "no aac"} : {kind: "ready"};
    });

    assert.equal(cache.started(false), false);
    assert.deepEqual(await cache.get(false), {kind: "ready"});
    assert.deepEqual(await cache.get(false), {kind: "ready"});
    assert.deepEqual(calls, [false]);
    assert.equal(cache.started(true), false);

    // The first Story with audio pays for the audio probe once; later ones reuse it.
    assert.deepEqual(await cache.get(true), {kind: "audio-unsupported", message: "no aac"});
    assert.deepEqual(await cache.get(true), {kind: "audio-unsupported", message: "no aac"});
    assert.deepEqual(await cache.get(false), {kind: "ready"});
    assert.deepEqual(calls, [false, true]);
  });

  it("a probe that rejects or throws is the unsupported result the UI shows, not a throw", async () => {
    const rejecting = createRenderCapabilityCache(async () => {
      throw new Error("no gpu");
    });
    const throwing = createRenderCapabilityCache(() => {
      throw new TypeError("boom");
    });
    const expected = (reason) => ({
      kind: "unsupported",
      message: `Browser render capability detection failed: ${reason}. Preview, YAML export, and the local CLI remain available.`,
    });

    assert.deepEqual(await rejecting.get(true), expected("no gpu"));
    assert.deepEqual(await rejecting.get(true), expected("no gpu"));
    assert.deepEqual(await throwing.get(false), expected("boom"));
  });

  it("a lazily loaded audio encoder chunk that cannot be fetched says to reload, whatever the browser words it", async () => {
    const withLocks = {getLocks: () => ({query: async () => ({held: [], pending: []})})};

    assert.equal(
      AUDIO_ENCODER_LOAD_MESSAGE,
      "Browser render could not load its audio encoder. Reload the page to try again. Preview, YAML export, and the local CLI remain available.",
    );

    for (const message of [
      "Failed to fetch dynamically imported module: https://tora.example/assets/aac-encoder-1a2b3c.js",
      "error loading dynamically imported module: https://tora.example/assets/aac-encoder-1a2b3c.js",
      "Importing a module script failed.",
      "Loading chunk 42 failed.",
    ]) {
      const capability = await checkBrowserRenderCapability({
        ...withLocks,
        hasAudio: true,
        canRender: async () => {
          throw new TypeError(message);
        },
      });

      assert.deepEqual(capability, {kind: "unsupported", message: AUDIO_ENCODER_LOAD_MESSAGE}, message);
    }

    // Another failure keeps the generic sentence, and a silent probe never blames the audio encoder.
    const generic = await checkBrowserRenderCapability({
      ...withLocks,
      hasAudio: true,
      canRender: async () => {
        throw new Error("no gpu");
      },
    });
    const silent = await checkBrowserRenderCapability({
      ...withLocks,
      canRender: async () => {
        throw new TypeError("Failed to fetch dynamically imported module: x.js");
      },
    });

    assert.match(generic.message, /^Browser render capability detection failed: no gpu\./u);
    assert.match(silent.message, /^Browser render capability detection failed: Failed to fetch dynamically imported module/u);
  });

  it("the cache keeps the reload message for the page session: one probe per audio state, as for any other failure", async () => {
    let probes = 0;
    const cache = createRenderCapabilityCache(async () => {
      probes += 1;

      throw new TypeError("Failed to fetch dynamically imported module: https://tora.example/assets/aac-encoder-1a2b3c.js");
    });
    const expected = {kind: "unsupported", message: AUDIO_ENCODER_LOAD_MESSAGE};

    assert.deepEqual(await cache.get(true), expected);
    assert.deepEqual(await cache.get(true), expected);
    assert.equal(probes, 1);
    // The silent probe is another entry and words the same error generically.
    assert.match((await cache.get(false)).message, /^Browser render capability detection failed:/u);
    assert.equal(probes, 2);
  });

  it("the page's UI check and its render clicks share one probe per audio state", async () => {
    const probes = [];
    const cache = createRenderCapabilityCache(async ({hasAudio}) => {
      probes.push(hasAudio);

      return {kind: "ready"};
    });
    const withAudio = {...exampleStory, music: {src: "whoosh"}};
    const busy = async () => ({mode: "busy"});
    // App's click passes this exact callback (pinned in tests/app-audio-render.test.mjs).
    const click = (story) =>
      startBrowserRenderTransaction(story, {
        signal: new AbortController().signal,
        checkCapability: () => cache.get(storyHasAudio(story)),
        acquireLock: busy,
      });

    // The UI check, then two clicks, for a Story with audio.
    await cache.get(true);
    assert.deepEqual(await click(withAudio), {kind: "busy"});
    assert.deepEqual(await click(withAudio), {kind: "busy"});
    assert.deepEqual(probes, [true]);

    // A silent Story's clicks add exactly one probe, for the silent state.
    assert.deepEqual(await click(exampleStory), {kind: "busy"});
    assert.deepEqual(await click(exampleStory), {kind: "busy"});
    assert.deepEqual(probes, [true, false]);
  });

  it("a click on a refused capability is the unsupported outcome the UI shows, with no lock taken", async () => {
    let locked = false;
    const cache = createRenderCapabilityCache(async () => {
      throw new Error("no gpu");
    });
    const outcome = await startBrowserRenderTransaction(exampleStory, {
      signal: new AbortController().signal,
      checkCapability: () => cache.get(false),
      acquireLock: async () => {
        locked = true;

        return {mode: "owner", release: () => undefined};
      },
    });

    assert.equal(outcome.kind, "unsupported");
    assert.match(outcome.message, /^Browser render capability detection failed: no gpu/u);
    assert.deepEqual(outcome, {kind: "unsupported", message: (await cache.get(false)).message});
    assert.equal(locked, false);
  });

  it("shares one in-flight probe between concurrent callers", async () => {
    let probes = 0;
    const cache = createRenderCapabilityCache(async () => {
      probes += 1;

      return {kind: "ready"};
    });

    await Promise.all([cache.get(true), cache.get(true), cache.get(true)]);
    assert.equal(probes, 1);
  });
});
