import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  AUDIO_FETCH_FAILED_MESSAGE,
  AUDIO_LOADING_MESSAGE,
  evaluateAudioRenderReadiness,
} from "../src/web/audioRenderReadiness.ts";
import {evaluateBrowserStoryPolicy, MAX_BROWSER_TOTAL_FRAMES} from "../src/web/browserPolicy.ts";
import {storyAudioDurations} from "../src/audio/storyAudio.ts";

const VOICE = `local:audio:sha256:${"a".repeat(64)}`;
const scene = (overrides = {}) => ({
  type: "dialogue",
  pose: "formal",
  background: "office",
  text: "Hi",
  duration: 3,
  ...overrides,
});
const dingStory = {title: "Ding", scenes: [scene({sfx: {src: "ding"}})]};
const states = (entries) => new Map(Object.entries(entries));
const NONE = {kind: "none"};
/** `durations` are the verified durations of the ready refs (a ready ref without one has no verified payload). */
const resolvedLocal = (refs, durations = {}) => ({
  kind: "resolved",
  refs: refs.map(([ref, status]) => ({usage: {ref, category: "audio"}, status, detail: null})),
  verified: new Map(
    refs
      .filter(([ref, status]) => status === "ready" && durations[ref] !== undefined)
      .map(([ref]) => [
        ref.slice(ref.length - 64),
        {
          digest: ref.slice(ref.length - 64),
          kind: "audio",
          mimeType: "audio/wav",
          byteSize: 1000,
          container: "wave",
          codec: "pcm",
          durationSeconds: durations[ref],
          sampleRate: 48_000,
          channels: 2,
        },
      ]),
  ),
  blobs: new Map(),
  allReady: refs.every(([, status]) => status === "ready"),
  failureMessage: null,
});
const evaluate = (story, bundled = {}, options = {}) =>
  evaluateAudioRenderReadiness({
    story,
    // The page's own map, which a failed duration read leaves without the local durations.
    audioDurations: options.audioDurations ?? storyAudioDurations(story),
    localState: options.localState ?? NONE,
    bundledStates: states(bundled),
  });
const issueKinds = (readiness) => readiness.plan.issues.map((issue) => issue.kind);

describe("readiness over the bundled-audio store's states", () => {
  it("a Story without audio is never blocked and compiles an empty plan", () => {
    const readiness = evaluate({title: "Silent", scenes: [scene()]});

    assert.equal(readiness.block, null);
    assert.deepEqual(readiness.plan.tracks, []);
    assert.deepEqual(readiness.plan.issues, []);
  });

  for (const [title, state] of [
    ["not requested yet (no entry)", undefined],
    ["loading", {kind: "loading"}],
    ["retrying", {kind: "retrying", attempt: 2}],
  ]) {
    it(`a bundled id that is ${title} has no track, a pending-audio issue and blocks with "Audio is still loading."`, () => {
      const readiness = evaluate(dingStory, state === undefined ? {} : {ding: state});

      assert.equal(readiness.block, "Audio is still loading.");
      assert.equal(AUDIO_LOADING_MESSAGE, "Audio is still loading.");
      assert.deepEqual(readiness.plan.tracks, []);
      assert.deepEqual(issueKinds(readiness), ["pending-audio"]);
    });
  }

  it("fetch-failed blocks with the retry sentence (still a pending-audio issue: the person can retry)", () => {
    const readiness = evaluate(dingStory, {ding: {kind: "fetch-failed", message: "Network"}});

    assert.equal(readiness.block, "Audio could not be loaded. Retry it in the editor.");
    assert.equal(AUDIO_FETCH_FAILED_MESSAGE, readiness.block);
    assert.deepEqual(issueKinds(readiness), ["pending-audio"]);
  });

  it("unusable blocks terminally with missing-audio and the id", () => {
    const readiness = evaluate(dingStory, {ding: {kind: "unusable", message: "bad"}});

    assert.equal(readiness.block, "Audio file ding cannot be used for rendering.");
    assert.deepEqual(readiness.plan.tracks, []);
    assert.deepEqual(issueKinds(readiness), ["missing-audio"]);
  });

  it("the same Story enables by itself when the store reports ready: track present, no block", () => {
    const blocked = evaluate(dingStory, {ding: {kind: "loading"}});
    const ready = evaluate(dingStory, {ding: {kind: "ready"}});

    assert.notEqual(blocked.block, null);
    assert.equal(ready.block, null);
    assert.deepEqual(ready.plan.issues, []);
    assert.deepEqual(ready.plan.tracks.map((track) => track.key), ["sfx-0"]);
  });

  it("reports a terminal problem before a failed fetch, a failed fetch before loading", () => {
    const story = {
      title: "Three",
      scenes: [scene({sfx: {src: "whoosh"}}), scene({sfx: {src: "boom"}}), scene({sfx: {src: "ding"}})],
    };

    assert.equal(
      evaluate(story, {
        whoosh: {kind: "loading"},
        boom: {kind: "fetch-failed", message: "x"},
        ding: {kind: "unusable", message: "y"},
      }).block,
      "Audio file ding cannot be used for rendering.",
    );
    assert.equal(
      evaluate(story, {
        whoosh: {kind: "loading"},
        boom: {kind: "fetch-failed", message: "x"},
        ding: {kind: "ready"},
      }).block,
      AUDIO_FETCH_FAILED_MESSAGE,
    );
  });
});

describe("readiness over the page's local-asset state", () => {
  const voiceStory = {title: "Voice", scenes: [scene({voice: {src: VOICE}})]};

  it("a verified local voice is ready with the duration its verified payload carries, even when the page's own duration map has no entry for it (a failed read never leaves 'Audio is still loading.')", () => {
    const readiness = evaluate(voiceStory, {}, {
      localState: resolvedLocal([[VOICE, "ready"]], {[VOICE]: 2.2}),
    });

    assert.equal(readiness.block, null);
    assert.deepEqual(readiness.plan.tracks.map((track) => track.key), ["voice-0"]);
    assert.deepEqual(readiness.audioDurations, {[VOICE]: 2.2});
  });

  it("a ready ref without a verified payload is terminal, never loading", () => {
    const readiness = evaluate(voiceStory, {}, {localState: resolvedLocal([[VOICE, "ready"]])});

    assert.match(readiness.block, /^Audio file aaaa…aaaa cannot be used for rendering.$/u);
    assert.deepEqual(issueKinds(readiness), ["missing-audio"]);
  });

  it("a local voice that is still resolving is loading; a missing, corrupt or unavailable one is terminal", () => {
    assert.equal(
      evaluate(voiceStory, {}, {localState: {kind: "pending", usages: []}}).block,
      AUDIO_LOADING_MESSAGE,
    );

    for (const status of ["missing", "corrupt", "unavailable"]) {
      const readiness = evaluate(voiceStory, {}, {
        localState: resolvedLocal([[VOICE, status]], {[VOICE]: 2.2}),
      });

      assert.match(readiness.block, /^Audio file aaaa…aaaa cannot be used for rendering\.$/u, status);
      assert.deepEqual(issueKinds(readiness), ["missing-audio"]);
    }
  });

  it("mixes a local voice and a bundled sfx, blocking on whichever is not ready", () => {
    const story = {title: "Both", scenes: [scene({voice: {src: VOICE}, sfx: {src: "ding"}})]};
    const options = {localState: resolvedLocal([[VOICE, "ready"]], {[VOICE]: 2.2})};

    assert.equal(evaluate(story, {ding: {kind: "loading"}}, options).block, AUDIO_LOADING_MESSAGE);
    assert.equal(evaluate(story, {ding: {kind: "ready"}}, options).block, null);
  });
});

describe("two different frame checks, on purpose", () => {
  const autoScene = () =>
    scene({voice: {src: "ding"}, duration: "auto"});
  const autoStory = (count) => ({
    title: "Auto",
    scenes: Array.from({length: count}, autoScene),
  });

  it("the acceptance policy counts each auto scene at its lower bound and accepts 101 of them with an empty map", () => {
    const story = autoStory(101);
    const policy = evaluateBrowserStoryPolicy(story);

    assert.equal(policy.eligible, true);
    // 101 x 16 frames, not 101 x 90 fallback frames (which would be over the cap).
    assert.equal(policy.totalFrames, 101 * 16);
    assert.ok(101 * 90 > MAX_BROWSER_TOTAL_FRAMES);
  });

  it("readiness checks the exact total: 101 bundled ding voices (51 frames each) fit, 101 three-second local voices do not", () => {
    assert.equal(
      evaluate(autoStory(101), {ding: {kind: "ready"}}).block,
      null,
    );

    const longStory = {
      title: "Long",
      scenes: Array.from({length: 101}, () => scene({voice: {src: VOICE}, duration: "auto"})),
    };
    const readiness = evaluate(longStory, {}, {
      localState: resolvedLocal([[VOICE, "ready"]], {[VOICE]: 3}),
    });

    // ceil((3 + 0.5) x 30) = 105 frames x 101 = 10,605 frames = 353.5 s.
    assert.equal(readiness.block, "This Story is longer than 300 s with its voices (354 s).");
  });

  it("exactly 9,000 frames (300 s) passes and one more frame blocks", () => {
    // Scenes of 3 s fixed + 1 auto scene: the auto scene has ceil((s + 0.5) x 30) frames.
    // 99 x 90 = 8,910 frames; the auto scene gets the remaining 90 (s = 2.5) or 91 (s = 2.5 + 1/30).
    const edgeStory = {
      title: "Edge",
      scenes: [
        ...Array.from({length: 99}, () => scene()),
        scene({voice: {src: VOICE}, duration: "auto"}),
      ],
    };
    const run = (seconds) =>
      evaluate(edgeStory, {}, {
        localState: resolvedLocal([[VOICE, "ready"]], {[VOICE]: seconds}),
      });

    assert.equal(run(2.5).block, null);
    assert.equal(
      run(2.5 + 1 / 30).block,
      "This Story is longer than 300 s with its voices (301 s).",
    );
  });

  it("a loading source is reported before the length, because a fallback scene would make the total meaningless", () => {
    const story = {
      title: "Long and loading",
      scenes: Array.from({length: 101}, () => scene({voice: {src: "ding"}, duration: "auto"})),
    };

    assert.equal(evaluate(story, {ding: {kind: "loading"}}).block, AUDIO_LOADING_MESSAGE);
  });
});
