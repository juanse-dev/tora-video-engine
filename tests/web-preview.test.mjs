import assert from "node:assert/strict";
import {describe, it} from "node:test";
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
