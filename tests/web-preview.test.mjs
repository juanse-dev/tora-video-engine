import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {exampleStory} from "../src/story/exampleStory.ts";
import {getWebPlayerConfig} from "../src/web/previewConfig.ts";
import {
  VIDEO_FPS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
} from "../src/videoConfig.ts";

describe("WEB-002 player metadata", () => {
  it("derives canonical Player metadata from the shared video config", () => {
    const config = getWebPlayerConfig(exampleStory);

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

    const config = getWebPlayerConfig(story);

    assert.equal(config.durationInFrames, 390);
  });
});
