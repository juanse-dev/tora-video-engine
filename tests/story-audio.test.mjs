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

  it("offsets the volume callback by the track start, through crossfades, ducking and fades", () => {
    // 5 x 4 s scenes (600 frames), 10 s music: copies at 0, 291 and 582; a ding
    // in scene 3 (frame 360) ducks the second copy.
    const musicStory = {
      title: "Music",
      music: {src: "calm-loop", fadeOut: 2},
      scenes: [
        scene({duration: 4}),
        scene({duration: 4}),
        scene({duration: 4}),
        scene({duration: 4, sfx: {src: "ding"}}),
        scene({duration: 4}),
      ],
    };
    const durations = {"calm-loop": 10, ding: 1.2};
    const sources = {
      "calm-loop": {kind: "url", url: "blob:music"},
      ding: {kind: "url", url: "blob:ding"},
    };
    const plan = compileAudioPlan({
      story: musicStory,
      timeline: compileTimeline(musicStory, 30, durations),
      fps: 30,
      audioDurations: durations,
      sourceState: (ref) =>
        audioSourceState(resolveAudioSrc(ref, sources, "explicit")),
    });
    const mounts = buildStoryAudioMounts({
      plan,
      sources,
      policy: "explicit",
      audioArmed: true,
    });
    const mountFor = (key) => {
      const track = plan.tracks.find((candidate) => candidate.key === key);
      const mount = mounts.find(
        (candidate) => candidate.key === `${key}:blob:music`,
      );

      assert.ok(track !== undefined && mount !== undefined, key);

      return {track, mount};
    };

    assert.deepEqual(
      plan.tracks.map((track) => [track.key, track.fromFrame]),
      [
        ["music-0", 0],
        ["music-1", 291],
        ["music-2", 582],
        ["sfx-3", 360],
      ],
    );

    // Every frame of every music copy reads the plan at the absolute frame.
    for (const key of ["music-0", "music-1", "music-2"]) {
      const {track, mount} = mountFor(key);

      for (let frame = 0; frame < track.durationInFrames; frame += 1) {
        assert.equal(
          mount.volumeAt(frame),
          track.gainAt(track.fromFrame + frame),
          `${key} frame ${frame}`,
        );
      }
    }

    // On the copy that does not start at frame 0 the offset matters: inside the
    // crossfade window (0-8) and inside the duck ramp (65-69).
    const {track, mount} = mountFor("music-1");

    for (const frame of [0, 4, 8, 65, 67, 69]) {
      assert.notEqual(
        mount.volumeAt(frame),
        track.gainAt(frame),
        `the offset must matter at frame ${frame}`,
      );
    }
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

describe("renders never fall back to another decode path", () => {
  const story = {
    title: "Mounts",
    scenes: [scene(), scene({sfx: {src: "ding"}})],
  };
  const sources = {ding: {kind: "url", url: "blob:ding"}};
  const mountsFor = (isRendering) =>
    buildStoryAudioMounts({
      plan: planFor(story, sources, "explicit"),
      sources,
      policy: "explicit",
      audioArmed: true,
      isRendering,
    });

  it("disallows the <Html5Audio> fallback while rendering and keeps it for the Player and Studio", () => {
    assert.equal(mountsFor(true)[0].disallowFallbackToHtml5Audio, true);
    assert.equal(mountsFor(false)[0].disallowFallbackToHtml5Audio, false);
    assert.equal(mountsFor(undefined)[0].disallowFallbackToHtml5Audio, false);
  });

  it("StoryAudio reads isRendering from Remotion and passes the flag to <Audio>", async () => {
    const source = await read("src/components/StoryAudio.tsx");

    assert.match(source, /useRemotionEnvironment()/);
    assert.match(source, /isRendering/);
    assert.match(
      source,
      /disallowFallbackToHtml5Audio={mount.disallowFallbackToHtml5Audio}/,
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
    assert.match(source, /key=\{mount\.key\}/);
    assert.match(source, /from=\{mount\.from\}/);
    assert.match(source, /durationInFrames=\{mount\.durationInFrames\}/);
    assert.match(source, /<Audio\s+src=\{mount\.src\}/);
    assert.match(source, /volume=\{\(frame\) => mount\.volumeAt\(frame\)\}/);
    assert.doesNotMatch(source, /compileTimeline/);

    // No `loop` attribute on any JSX element (comments are ignored).
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    assert.doesNotMatch(code, /\sloop[\s=>/{]/);
  });

  it("ToraVideo mounts StoryAudio next to StoryRenderer inside the image provider and passes the same timeline", async () => {
    const source = await read("src/Video.tsx");
    const provider = source.indexOf("<LocalAssetSourcesProvider");
    const renderer = source.indexOf("<StoryRenderer timeline={timeline} />");
    const audio = source.indexOf("<StoryAudio");

    assert.ok(provider >= 0 && renderer > provider && audio > renderer);
    assert.ok(source.indexOf("</LocalAssetSourcesProvider>") > audio);
    const element = source.match(/<StoryAudio[\s\S]*?\/>/)?.[0] ?? "";
    const providerTag =
      source.match(/<AudioSourcesProvider[\s\S]*?>/)?.[0] ?? "";

    assert.match(element, /story=\{story\}/);
    assert.match(element, /timeline=\{timeline\}/);
    assert.match(element, /fps=\{fps\}/);
    assert.match(element, /audioDurations=\{audioDurations\}/);
    assert.match(element, /audioArmed=\{audioArmed\}/);
    assert.match(providerTag, /sources=\{audioSources\}/);
    assert.match(providerTag, /policy=\{bundledAudioPolicy \?\? "static-fallback"\}/);
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
