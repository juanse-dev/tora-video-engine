import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {buildStoryRenderPlan} from "../src/renderPlan.ts";
import {getStoryMetadata} from "../src/story/metadata.ts";
import {compileTimeline} from "../src/story/timeline.ts";
import {getWebPlayerConfig} from "../src/web/previewConfig.ts";

const voice = `local:audio:sha256:${"d".repeat(64)}`;
const story = {title: "T", scenes: [
  {type: "intro", pose: "formal", background: "office", text: "A", duration: "auto", voice: {src: voice}},
  {type: "dialogue", pose: "confused", background: "office", text: "B", duration: 3},
]};
const map = {[voice]: 2.2};

describe("one timeline per composition", () => {
  it("render plan, metadata and Player config agree for the same map", () => {
    const timeline = compileTimeline(story, 30, map);
    const plan = buildStoryRenderPlan(timeline);
    assert.deepEqual(plan.scenes.map((s) => [s.from, s.durationInFrames]), [[0, 81], [81, 90]]);
    assert.equal(getStoryMetadata(story, 30, map).durationInFrames, 171);
    assert.equal(getWebPlayerConfig(story, map).durationInFrames, 171);
  });

  it("a 4.5 s voice is not cut at the 3 s fallback", () => {
    assert.equal(getWebPlayerConfig(story, {[voice]: 4.5}).durationInFrames, 150 + 90);
  });
});
