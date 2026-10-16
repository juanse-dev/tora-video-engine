import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {readFile} from "node:fs/promises";
import {exampleStory} from "../src/story/exampleStory.ts";
import {storyAudioDurations} from "../src/audio/storyAudio.ts";
import {getWebPlayerConfig} from "../src/web/previewConfig.ts";
import {
  VIDEO_FPS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
} from "../src/videoConfig.ts";

describe("WEB-002 player metadata", () => {
  it("derives canonical Player metadata from the shared video config", () => {
    const config = getWebPlayerConfig(exampleStory, {});

    assert.deepEqual(config, {
      compositionHeight: VIDEO_HEIGHT,
      compositionWidth: VIDEO_WIDTH,
      durationInFrames: 360,
      fps: VIDEO_FPS,
    });
    assert.equal(config.compositionWidth, 1080);
    assert.equal(config.compositionHeight, 1920);
    assert.equal(config.fps, 30);
  });

  it("derives duration from Story content instead of a web magic number", () => {
    const story = structuredClone(exampleStory);
    story.scenes[0].duration = 4;

    const config = getWebPlayerConfig(story, {});

    assert.equal(config.durationInFrames, 390);
  });

  it("builds the Preview config from the Story's own duration map", () => {
    const plain = getWebPlayerConfig(
      exampleStory,
      storyAudioDurations(exampleStory),
    );

    assert.equal(plain.durationInFrames, 360);

    const audioStory = structuredClone(exampleStory);
    audioStory.music = {src: "calm-loop"};
    audioStory.scenes[0].sfx = {src: "whoosh"};
    audioStory.scenes[1].duration = "auto";
    audioStory.scenes[1].voice = {src: "ding"};

    const audioConfig = getWebPlayerConfig(
      audioStory,
      storyAudioDurations(audioStory),
    );
    const fallbackConfig = getWebPlayerConfig(audioStory, {});
    const otherScenesFrames =
      360 - exampleStory.scenes[1].duration * 30;

    // The bundled ding is 1.2 s: the auto scene lasts ceil((1.2 + 0.5) * 30) = 51 frames.
    assert.equal(audioConfig.durationInFrames, otherScenesFrames + 51);
    // Without the map the auto scene falls back to 3 s = 90 frames.
    assert.equal(fallbackConfig.durationInFrames, otherScenesFrames + 90);
    assert.notEqual(
      audioConfig.durationInFrames,
      fallbackConfig.durationInFrames,
    );
  });
});

describe("AUDIO-002 Player length and audio props", () => {
  const voice = `local:audio:sha256:${"f".repeat(64)}`;
  const autoStory = {
    title: "Auto voice",
    scenes: [
      {
        type: "intro",
        pose: "formal",
        background: "office",
        text: "Hi",
        duration: "auto",
        voice: {src: voice},
      },
    ],
  };

  it("sizes the Player from the voice duration, falling back to 3 s", () => {
    // ceil((2.2 + 0.5) * 30) = 81; no map entry = the 3 s fallback = 90;
    // ceil((4.5 + 0.5) * 30) = 150 (a long voice is not cut at the fallback).
    assert.equal(
      getWebPlayerConfig(autoStory, {[voice]: 2.2}).durationInFrames,
      81,
    );
    assert.equal(getWebPlayerConfig(autoStory, {}).durationInFrames, 90);
    assert.equal(
      getWebPlayerConfig(autoStory, {[voice]: 4.5}).durationInFrames,
      150,
    );
  });

  it("Preview takes one required duration map and feeds it to the Player length and to inputProps", async () => {
    const source = await readFile(
      new URL("../src/web/components/Preview.tsx", import.meta.url),
      "utf8",
    );

    assert.match(source, /audioDurations: AudioDurationMap;/);
    assert.match(source, /getWebPlayerConfig\(story, audioDurations\)/);
    assert.match(source, /inputProps = useMemo\([\s\S]*?audioDurations,[\s\S]*?\)/);
    assert.doesNotMatch(source, /storyAudioDurations\(/);
  });

  it("Preview starts the Player muted, shows volume controls only for audio and arms in a layout effect", async () => {
    const source = await readFile(
      new URL("../src/web/components/Preview.tsx", import.meta.url),
      "utf8",
    );

    assert.match(source, /\binitiallyMuted\b/);
    assert.match(source, /showVolumeControls=\{hasAudio\}/);
    assert.doesNotMatch(source, /showVolumeControls=\{false\}/);
    assert.match(source, /initialVolume=\{initialVolume\}/);
    assert.match(source, /const hasAudio = storyHasAudio\(story\)/);
    assert.match(source, /useState\(false\)/);
    assert.match(source, /const audioArmed = hasAudio && armed/);
    assert.match(source, /useLayoutEffect\(/);
    assert.match(source, /applyArmingAction\(/);
    assert.match(source, /bundledAudioPolicy: "explicit" as const/);
    assert.doesNotMatch(source, /Stories are video-only/);
  });
});
