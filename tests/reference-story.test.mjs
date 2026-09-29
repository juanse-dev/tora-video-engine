import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {describe, it} from "node:test";
import YAML from "yaml";
import {buildStoryRenderPlan} from "../src/renderPlan.ts";
import {exampleStory} from "../src/story/exampleStory.ts";
import {loadStory} from "../src/story/loadStory.ts";
import {compileTimeline} from "../src/story/timeline.ts";
import {
  VIDEO_FPS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
} from "../src/videoConfig.ts";

const referencePath = resolve("stories/friday-deploy.yaml");

const withMutatedStory = async (mutate, callback) => {
  const source = await readFile(referencePath, "utf8");
  const story = YAML.parse(source);
  mutate(story);

  const directory = await mkdtemp(
    join(tmpdir(), "tora-video-engine-reference-"),
  );
  const path = join(directory, "friday-deploy.yaml");

  try {
    await writeFile(path, YAML.stringify(story), "utf8");
    const loaded = await loadStory(path);
    await callback(loaded);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
};

describe("MVP reference story", () => {
  it("matches the canonical v0.1 story exactly", async () => {
    const story = await loadStory(referencePath);

    assert.deepEqual(story, {
      title: "Deploy Friday",
      scenes: [
        {
          type: "intro",
          pose: "formal",
          background: "office",
          animation: "fade",
          text: "Tora tiene una regla.",
          duration: 3,
        },
        {
          type: "dialogue",
          pose: "confused",
          background: "office",
          animation: "float",
          text: "Pero es solo un cambio pequeño...",
          duration: 3,
        },
        {
          type: "chaos",
          pose: "panic",
          background: "server-room",
          text: "Production is down.",
          duration: 3,
        },
        {
          type: "punchline",
          pose: "coffee",
          background: "office",
          animation: "slowZoom",
          text: "Era un cambio pequeño.",
          duration: 3,
        },
      ],
    });

    assert.deepEqual(exampleStory, story);
  });

  it("compiles to the exact golden timeline", async () => {
    const story = await loadStory(referencePath);
    const timeline = compileTimeline(story, VIDEO_FPS);

    assert.deepEqual(
      timeline.scenes.map(({from, durationInFrames}) => ({
        from,
        durationInFrames,
      })),
      [
        {from: 0, durationInFrames: 90},
        {from: 90, durationInFrames: 90},
        {from: 180, durationInFrames: 90},
        {from: 270, durationInFrames: 90},
      ],
    );
    assert.equal(timeline.durationInFrames, 360);
    assert.equal(timeline.durationInFrames / VIDEO_FPS, 12);
  });

  it("keeps the v0.1 output contract vertical at 30 FPS", () => {
    assert.equal(VIDEO_WIDTH, 1080);
    assert.equal(VIDEO_HEIGHT, 1920);
    assert.equal(VIDEO_FPS, 30);
  });

  it("responds to YAML-only scene order and caption mutations", async () => {
    await withMutatedStory(
      (story) => {
        [story.scenes[0], story.scenes[1]] = [
          story.scenes[1],
          story.scenes[0],
        ];
        story.scenes[0].text = "Mutated caption";
      },
      async (story) => {
        const renderPlan = buildStoryRenderPlan(story, VIDEO_FPS);

        assert.deepEqual(
          renderPlan.scenes.map(({type}) => type),
          ["dialogue", "intro", "chaos", "punchline"],
        );
        assert.equal(renderPlan.scenes[0].text, "Mutated caption");
      },
    );
  });

  it("responds to YAML-only duration mutations", async () => {
    await withMutatedStory(
      (story) => {
        story.scenes[0].duration = 4;
      },
      async (story) => {
        const renderPlan = buildStoryRenderPlan(story, VIDEO_FPS);

        assert.deepEqual(
          renderPlan.scenes.map(({from}) => from),
          [0, 120, 210, 300],
        );
        assert.equal(renderPlan.durationInFrames, 390);
      },
    );
  });

  it("responds to YAML-only pose, background, and animation mutations", async () => {
    await withMutatedStory(
      (story) => {
        story.scenes[0].pose = "coffee";
        story.scenes[0].background = "server-room";
        story.scenes[0].animation = "slowZoom";
      },
      async (story) => {
        const renderPlan = buildStoryRenderPlan(story, VIDEO_FPS);
        const renderedScene = renderPlan.scenes[0];

        assert.equal(renderedScene.pose, "coffee");
        assert.equal(renderedScene.background, "server-room");
        assert.equal(renderedScene.animation, "slowZoom");
      },
    );
  });
});
