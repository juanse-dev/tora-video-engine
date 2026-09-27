import assert from "node:assert/strict";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {describe, it} from "node:test";
import {loadStory} from "../src/story/loadStory.ts";
import {compileTimeline} from "../src/story/timeline.ts";

const withYaml = async (content, callback) => {
  const directory = await mkdtemp(join(tmpdir(), "tora-video-engine-"));
  const path = join(directory, "story.yaml");

  try {
    await writeFile(path, content, "utf8");
    return await callback(path);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
};

const expectInvalidStory = async (content, expectedPath) => {
  await withYaml(content, async (path) => {
    await assert.rejects(
      () => loadStory(path),
      new RegExp(expectedPath.replaceAll(".", "\\.")),
    );
  });
};

describe("loadStory", () => {
  it("loads the reference YAML into the renderer domain shape", async () => {
    const story = await loadStory(resolve("stories/friday-deploy.yaml"));

    assert.equal(story.title, "Deploy Friday");
    assert.equal(story.scenes.length, 4);
    assert.deepEqual(
      story.scenes.map(({type}) => type),
      ["intro", "dialogue", "chaos", "punchline"],
    );

    const timeline = compileTimeline(story, 30);
    assert.equal(timeline.durationInFrames, 360);
  });

  it("rejects an empty scenes array", async () => {
    await expectInvalidStory(
      `title: Test
scenes: []
`,
      "scenes",
    );
  });

  it("rejects an unknown scene type", async () => {
    await expectInvalidStory(
      `title: Test
scenes:
  - type: montage
    pose: formal
    background: office
    text: Test
    duration: 1
`,
      "scenes.0.type",
    );
  });

  it("rejects an unknown pose", async () => {
    await expectInvalidStory(
      `title: Test
scenes:
  - type: intro
    pose: sleepy
    background: office
    text: Test
    duration: 1
`,
      "scenes.0.pose",
    );
  });

  it("rejects an unknown background", async () => {
    await expectInvalidStory(
      `title: Test
scenes:
  - type: intro
    pose: formal
    background: kitchen
    text: Test
    duration: 1
`,
      "scenes.0.background",
    );
  });

  it("rejects an unknown animation", async () => {
    await expectInvalidStory(
      `title: Test
scenes:
  - type: intro
    pose: formal
    background: office
    animation: explode
    text: Test
    duration: 1
`,
      "scenes.0.animation",
    );
  });

  it("rejects a missing text field", async () => {
    await expectInvalidStory(
      `title: Test
scenes:
  - type: intro
    pose: formal
    background: office
    duration: 1
`,
      "scenes.0.text",
    );
  });

  it("rejects zero duration", async () => {
    await expectInvalidStory(
      `title: Test
scenes:
  - type: intro
    pose: formal
    background: office
    text: Test
    duration: 0
`,
      "scenes.0.duration",
    );
  });

  it("rejects negative duration", async () => {
    await expectInvalidStory(
      `title: Test
scenes:
  - type: intro
    pose: formal
    background: office
    text: Test
    duration: -1
`,
      "scenes.0.duration",
    );
  });

  it("rejects a positive duration that cannot produce a frame", async () => {
    await expectInvalidStory(
      `title: Test
scenes:
  - type: intro
    pose: formal
    background: office
    text: Too short
    duration: 0.001
`,
      "scenes.0.duration",
    );
  });

  it("rejects a duration whose frame count overflows", async () => {
    await expectInvalidStory(
      `title: Test
scenes:
  - type: intro
    pose: formal
    background: office
    text: Too long
    duration: 1e308
`,
      "scenes.0.duration",
    );
  });

  it("rejects a story whose cumulative frame count overflows", async () => {
    await expectInvalidStory(
      `title: Test
scenes:
  - type: intro
    pose: formal
    background: office
    text: Almost max
    duration: 300239975158033
  - type: dialogue
    pose: confused
    background: office
    text: Last safe frame
    duration: 0.03
  - type: punchline
    pose: coffee
    background: office
    text: Overflow
    duration: 0.03
`,
      "scenes.2.duration",
    );
  });

  it("rejects malformed YAML before schema validation", async () => {
    await withYaml(
      `title: Broken
scenes:
  - type: intro
    pose: [formal
`,
      async (path) => {
        await assert.rejects(
          () => loadStory(path),
          /Failed to parse YAML/,
        );
      },
    );
  });
});
