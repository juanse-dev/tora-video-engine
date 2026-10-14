import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {describe, it} from "node:test";
import {staticFile} from "remotion";
import {buildStoryAudioMounts} from "../src/audio/mounts.ts";
import {compileAudioPlan} from "../src/audio/plan.ts";
import {audioSourceState, resolveAudioSrc} from "../src/audio/sources.ts";
import {storyAudioDurations} from "../src/audio/storyAudio.ts";
import {compileTimeline} from "../src/story/timeline.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const scene = (overrides = {}) => ({
  type: "dialogue",
  pose: "formal",
  background: "office",
  text: "Hi",
  duration: 3,
  ...overrides,
});
const planFor = (story, sources, policy) => {
  const durations = storyAudioDurations(story);

  return compileAudioPlan({
    story,
    timeline: compileTimeline(story, 30, durations),
    fps: 30,
    audioDurations: durations,
    sourceState: (ref) =>
      audioSourceState(resolveAudioSrc(ref, sources, policy)),
  });
};

describe("buildStoryAudioMounts", () => {
  const story = {
    title: "Mounts",
    scenes: [scene(), scene({sfx: {src: "ding", volume: 0.5}})],
  };
  const dingSrc = staticFile("audio/sfx/ding.wav");

  it("mounts the plan's tracks when audioArmed is absent (Studio default props, a plain render)", () => {
    const plan = planFor(story, undefined, "static-fallback");
    const mounts = buildStoryAudioMounts({
      plan,
      sources: undefined,
      policy: "static-fallback",
      audioArmed: undefined,
    });

    assert.equal(mounts.length, 1);
    assert.deepEqual(
      [mounts[0].key, mounts[0].from, mounts[0].durationInFrames, mounts[0].src],
      [`sfx-1:${dingSrc}`, 90, 36, dingSrc],
    );
    // The volume callback receives the frame inside the sequence.
    assert.equal(mounts[0].volumeAt(0), 0.5);
    assert.equal(mounts[0].volumeAt(35), 0.5);
  });

  it("mounts the same with audioArmed true and nothing with exactly false", () => {
    const plan = planFor(story, undefined, "static-fallback");
    const mount = (audioArmed) =>
      buildStoryAudioMounts({
        plan,
        sources: undefined,
        policy: "static-fallback",
        audioArmed,
      });

    assert.equal(mount(true).length, 1);
    assert.equal(mount(false).length, 0);
  });

  it("mounts nothing for a Story without audio", () => {
    const silent = {title: "Silent", scenes: [scene()]};
    const plan = planFor(silent, undefined, "static-fallback");

    assert.deepEqual(
      buildStoryAudioMounts({
        plan,
        sources: undefined,
        policy: "static-fallback",
        audioArmed: true,
      }),
      [],
    );
  });

  it("uses the resolved source and keys the mount by it, so a new source remounts", () => {
    const sourcesA = {ding: {kind: "url", url: "blob:a"}};
    const sourcesB = {ding: {kind: "url", url: "blob:b"}};
    const keyFor = (sources) =>
      buildStoryAudioMounts({
        plan: planFor(story, sources, "explicit"),
        sources,
        policy: "explicit",
        audioArmed: true,
      })[0].key;

    assert.equal(keyFor(sourcesA), "sfx-1:blob:a");
    assert.equal(keyFor(sourcesB), "sfx-1:blob:b");
  });

  it("mounts nothing for a bundled sound the Player has no verified source for yet", () => {
    const plan = planFor(story, {}, "explicit");

    assert.deepEqual(plan.tracks, []);
    assert.deepEqual(
      buildStoryAudioMounts({
        plan,
        sources: {},
        policy: "explicit",
        audioArmed: true,
      }),
      [],
    );
  });
});

describe("StoryAudio and the composition (source contract)", () => {
  it("StoryAudio maps plan mounts to Sequence + Audio from @remotion/media, with no native loop", async () => {
    const source = await read("src/components/StoryAudio.tsx");

    assert.match(source, /import \{Audio\} from "@remotion\/media"/);
    assert.match(source, /buildStoryAudioMounts\(/);
    assert.match(source, /compileAudioPlan\(/);
    assert.match(source, /layout="none"/);
    assert.match(source, /volume=\{\(frame\) => mount\.volumeAt\(frame\)\}/);
    assert.doesNotMatch(source, /compileTimeline/);
    assert.doesNotMatch(source, /\bloop\b/);
  });

  it("ToraVideo mounts StoryAudio next to StoryRenderer inside the image provider and passes the same timeline", async () => {
    const source = await read("src/Video.tsx");
    const provider = source.indexOf("<LocalAssetSourcesProvider");
    const renderer = source.indexOf("<StoryRenderer timeline={timeline} />");
    const audio = source.indexOf("<StoryAudio");

    assert.ok(provider >= 0 && renderer > provider && audio > renderer);
    assert.ok(source.indexOf("</LocalAssetSourcesProvider>") > audio);
    assert.match(source, /<StoryAudio[\s\S]*timeline=\{timeline\}/);
    assert.match(source, /audioArmed=\{audioArmed\}/);
    assert.match(source, /bundledAudioPolicy \?\? "static-fallback"/);
    assert.equal((source.match(/compileTimeline\(/g) ?? []).length, 1);
  });

  it("Remotion Studio's default props leave the audio armed", async () => {
    const root = await read("src/Root.tsx");

    assert.match(root, /defaultProps=\{\{story: exampleStory\}\}/);
    assert.doesNotMatch(root, /audioArmed/);
  });

  it("the audio provider is separate from the image provider", async () => {
    const audio = await read("src/components/audioSources.tsx");
    const image = await read("src/components/visualAssetSource.tsx");

    assert.match(audio, /export const AudioSourcesProvider/);
    assert.match(audio, /export const useAudioSources/);
    assert.doesNotMatch(image, /Audio/);
  });
});
