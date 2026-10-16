import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {describe, it} from "node:test";
import {buildStoryAudioMounts} from "../src/audio/mounts.ts";
import {compileAudioPlan} from "../src/audio/plan.ts";
import {
  audioSourceState,
  buildAudioSourceMap,
  resolveAudioSrc,
} from "../src/audio/sources.ts";
import {storyAudioDurations} from "../src/audio/storyAudio.ts";
import {compileTimeline} from "../src/story/timeline.ts";
import {
  audioSourceForBundledState,
  bundledAudioKey,
  parseBundledAudioKey,
} from "../src/web/audio/bundledAudio.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const LOCAL = `local:audio:sha256:${"c".repeat(64)}`;
const scene = (overrides = {}) => ({
  type: "dialogue",
  pose: "formal",
  background: "office",
  text: "Hi",
  duration: 3,
  ...overrides,
});
const story = {
  title: "Bundled",
  scenes: [
    scene({sfx: {src: "ding"}}),
    scene({sfx: {src: "pop"}, voice: {src: LOCAL}}),
    scene({sfx: {src: "ding"}}),
  ],
};
const ready = (id) => ({
  kind: "ready",
  peaks: {peaksPerSecond: 50, peaks: new Uint8Array(2)},
  blob: new Blob([id]),
  url: `blob:http://localhost/${id}`,
});

/** What the Player does for these store states: the App's source map, then StoryAudio's plan and mounts. */
const playerFor = (states, localSources = {[LOCAL]: {kind: "url", url: "blob:http://localhost/voice"}}) => {
  const sources = buildAudioSourceMap(story, localSources, (id) =>
    audioSourceForBundledState(states[id]),
  );
  const durations = storyAudioDurations(story, {[LOCAL]: 2.2});
  const plan = compileAudioPlan({
    story,
    timeline: compileTimeline(story, 30, durations),
    fps: 30,
    audioDurations: durations,
    sourceState: (ref) => audioSourceState(resolveAudioSrc(ref, sources, "explicit")),
  });
  const mounts = buildStoryAudioMounts({plan, sources, policy: "explicit", audioArmed: true});

  return {sources, plan, mounts};
};
const issueKinds = (plan) => plan.issues.map((issue) => `${issue.kind}:${issue.ref}`).sort();

describe("the Player's bundled audio follows the store (policy explicit)", () => {
  it("mounts no bundled track before the store has an answer, and the local voice still plays", () => {
    const {mounts, plan} = playerFor({});

    assert.deepEqual(issueKinds(plan), ["pending-audio:ding", "pending-audio:ding", "pending-audio:pop"]);
    assert.deepEqual(mounts.map((mount) => mount.src), ["blob:http://localhost/voice"]);
  });

  it("loading, retrying and fetch-failed all keep the track out, as pending (never missing)", () => {
    for (const state of [
      {kind: "loading"},
      {kind: "retrying", attempt: 2},
      {kind: "fetch-failed", message: "Audio could not be loaded."},
    ]) {
      const {mounts, plan} = playerFor({ding: state, pop: state});

      assert.equal(plan.issues.every((issue) => issue.kind === "pending-audio"), true, state.kind);
      assert.equal(mounts.length, 1, state.kind);
    }
  });

  it("an unusable id is missing: no track and one missing-audio issue per use, while the other sounds play", () => {
    const {mounts, plan} = playerFor({ding: {kind: "unusable", message: "x"}, pop: ready("pop")});

    assert.deepEqual(issueKinds(plan), ["missing-audio:ding", "missing-audio:ding"]);
    assert.deepEqual(mounts.map((mount) => mount.src).sort(), ["blob:http://localhost/pop", "blob:http://localhost/voice"]);
  });

  it("a ready id mounts from the store's blob: URL, never from the static file, once per use", () => {
    const {mounts, plan} = playerFor({ding: ready("ding"), pop: ready("pop")});

    assert.deepEqual(plan.issues, []);
    assert.equal(mounts.length, 4);
    assert.equal(mounts.every((mount) => mount.src.startsWith("blob:")), true);
    assert.equal(mounts.some((mount) => mount.src.includes("/audio/sfx/")), false);
    assert.deepEqual(
      mounts.filter((mount) => mount.src.endsWith("/ding")).map((mount) => mount.from),
      [0, 180],
    );
  });

  it("a track appears as soon as the store turns ready, with nothing else changing", () => {
    const before = playerFor({ding: {kind: "loading"}, pop: ready("pop")});
    const after = playerFor({ding: ready("ding"), pop: ready("pop")});

    assert.equal(before.mounts.length, 2);
    assert.equal(after.mounts.length, 4);
    assert.deepEqual(
      before.plan.tracks.map((track) => track.key),
      after.plan.tracks.map((track) => track.key).filter((key) => key === "voice-1" || key === "sfx-1"),
    );
  });

  it("passes a local entry through as the same object and builds no entry for a Story without audio", () => {
    const entry = {kind: "url", url: "blob:http://localhost/voice"};
    const {sources} = playerFor({}, {[LOCAL]: entry});

    assert.equal(sources[LOCAL], entry);
    assert.deepEqual(
      buildAudioSourceMap({title: "Silent", scenes: [scene()]}, undefined, () => ({kind: "pending"})),
      {},
    );
  });
});

describe("the requested bundled set", () => {
  it("is the Story's distinct bundled ids, sorted, and does not depend on scene order or local audio", () => {
    assert.equal(bundledAudioKey(story), "ding,pop");
    assert.equal(bundledAudioKey({...story, scenes: [...story.scenes].reverse()}), "ding,pop");
    assert.equal(bundledAudioKey({title: "T", scenes: [scene()]}), "");
    assert.equal(bundledAudioKey({title: "T", scenes: [scene({voice: {src: LOCAL}, duration: "auto"})]}), "");
    assert.deepEqual(parseBundledAudioKey("ding,pop"), ["ding", "pop"]);
    assert.deepEqual(parseBundledAudioKey(""), []);
  });
});

describe("App and Preview wiring (the Player no longer falls back to the static file)", () => {
  it("Preview takes the sources from App and resolves bundled ids explicitly", async () => {
    const source = await read("src/web/components/Preview.tsx");

    assert.match(source, /audioSources: AudioSourceMap;/);
    assert.match(source, /bundledAudioPolicy: "explicit" as const/);
    assert.doesNotMatch(source, /static-fallback/);
    assert.doesNotMatch(source, /noBundledAudio|buildAudioSourceMap\(/);
  });

  it("App requests the Story's bundled ids from the store and builds the Player's map from its states", async () => {
    const source = await read("src/web/App.tsx");

    assert.match(source, /const bundledStates = useBundledAudioStates\(\);/);
    assert.match(source, /requestBundledAudio\(parseBundledAudioKey\(bundledKey\)\)/);
    assert.match(source, /buildAudioSourceMap\(activeStory, localAssets\.sources,/);
    assert.match(source, /audioSourceForBundledState\(bundledStates\.get\(id\)\)/);
    assert.match(source, /audioSources=\{audioSources\}/);
  });
});
