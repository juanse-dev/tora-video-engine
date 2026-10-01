import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {exampleStory} from "../src/story/exampleStory.ts";
import {
  MAX_BROWSER_CANONICAL_YAML_BYTES,
  MAX_BROWSER_TITLE_CODE_UNITS,
  MAX_BROWSER_TOTAL_FRAMES,
  MAX_VISUAL_CAPTION_CODE_UNITS,
  evaluateBrowserStoryPolicy,
} from "../src/web/browserPolicy.ts";
import {
  addVisualScene,
  canAddVisualScene,
  deleteVisualScene,
  evaluateVisualDraft,
  getVisualYamlTransitionActions,
  moveVisualScene,
  storyToVisualDraft,
  validateRawVisualCaption,
  validateRawVisualTitle,
} from "../src/web/visualDraft.ts";

describe("WEB-003 browser Story policy", () => {
  it("accepts the canonical Story", () => {
    const result = evaluateBrowserStoryPolicy(exampleStory);

    assert.equal(result.eligible, true);
    assert.equal(result.totalFrames, 360);
    assert.ok(result.canonicalBytes <= MAX_BROWSER_CANONICAL_YAML_BYTES);
  });

  it("rejects oversized title before timeline or serialization", () => {
    let timelineCalls = 0;
    let serializeCalls = 0;
    const story = {
      ...exampleStory,
      title: "a".repeat(MAX_BROWSER_TITLE_CODE_UNITS + 1),
    };

    const result = evaluateBrowserStoryPolicy(story, {
      deriveTotalFrames: () => {
        timelineCalls += 1;
        return 1;
      },
      serialize: () => {
        serializeCalls += 1;
        return "";
      },
    });

    assert.equal(result.eligible, false);
    assert.equal(result.reason, "title");
    assert.equal(timelineCalls, 0);
    assert.equal(serializeCalls, 0);
  });

  it("rejects 201 scenes before timeline or serialization", () => {
    let timelineCalls = 0;
    let serializeCalls = 0;
    const story = {
      ...exampleStory,
      scenes: Array.from(
        {length: 201},
        () => structuredClone(exampleStory.scenes[0]),
      ),
    };

    const result = evaluateBrowserStoryPolicy(story, {
      deriveTotalFrames: () => {
        timelineCalls += 1;
        return 1;
      },
      serialize: () => {
        serializeCalls += 1;
        return "";
      },
    });

    assert.equal(result.eligible, false);
    assert.equal(result.reason, "scene-count");
    assert.equal(timelineCalls, 0);
    assert.equal(serializeCalls, 0);
  });

  it("rejects duration before serialization", () => {
    let serializeCalls = 0;

    const result = evaluateBrowserStoryPolicy(exampleStory, {
      deriveTotalFrames: () => MAX_BROWSER_TOTAL_FRAMES + 1,
      serialize: () => {
        serializeCalls += 1;
        return "";
      },
    });

    assert.equal(result.eligible, false);
    assert.equal(result.reason, "duration");
    assert.equal(serializeCalls, 0);
  });

  it("checks canonical UTF-8 bytes only after earlier gates pass", () => {
    const result = evaluateBrowserStoryPolicy(exampleStory, {
      deriveTotalFrames: () => MAX_BROWSER_TOTAL_FRAMES,
      serialize: () => "ok",
      utf8ByteLength: () => MAX_BROWSER_CANONICAL_YAML_BYTES + 1,
    });

    assert.equal(result.eligible, false);
    assert.equal(result.reason, "canonical-yaml");
  });
});

describe("WEB-003 visual draft transformations", () => {
  it("turns valid edits into an eligible Story", () => {
    const draft = storyToVisualDraft(exampleStory);
    draft.title = "Edited";
    draft.scenes[0].text = "Edited caption";
    draft.scenes[0].animation = "";

    const result = evaluateVisualDraft(draft);

    assert.equal(result.kind, "eligible");
    assert.equal(result.story.title, "Edited");
    assert.equal(result.story.scenes[0].text, "Edited caption");
    assert.equal(result.story.scenes[0].animation, undefined);
  });

  it("keeps invalid duration as a pending schema-invalid draft", () => {
    const draft = storyToVisualDraft(exampleStory);
    draft.scenes[0].duration = "";

    const result = evaluateVisualDraft(draft);

    assert.equal(result.kind, "schema-invalid");
    assert.match(result.errors["scenes.0.duration"], /number|finite/i);
    assert.deepEqual(getVisualYamlTransitionActions(result), [
      "discard",
      "stay",
    ]);
  });

  it("retains a 201-scene candidate as policy-rejected", () => {
    let draft = storyToVisualDraft({
      ...exampleStory,
      scenes: Array.from(
        {length: 200},
        () => structuredClone(exampleStory.scenes[0]),
      ),
    });

    assert.equal(canAddVisualScene(draft), true);
    draft = addVisualScene(draft);
    assert.equal(draft.scenes.length, 201);
    assert.equal(canAddVisualScene(draft), false);

    const unchanged = addVisualScene(draft);
    assert.equal(unchanged, draft);
    assert.equal(unchanged.scenes.length, 201);

    const result = evaluateVisualDraft(draft);
    assert.equal(result.kind, "policy-rejected");
    assert.equal(result.policy.reason, "scene-count");
    assert.deepEqual(getVisualYamlTransitionActions(result), [
      "open-candidate-in-yaml",
      "discard",
      "stay",
    ]);

    draft = deleteVisualScene(draft, 200);
    assert.equal(draft.scenes.length, 200);
    assert.equal(canAddVisualScene(draft), true);
  });

  it("never deletes the final scene and reorders without timeline data", () => {
    const oneScene = storyToVisualDraft({
      ...exampleStory,
      scenes: [structuredClone(exampleStory.scenes[0])],
    });

    assert.equal(deleteVisualScene(oneScene, 0), oneScene);

    const draft = storyToVisualDraft(exampleStory);
    const moved = moveVisualScene(draft, 0, 1);
    assert.equal(moved.scenes[0].text, exampleStory.scenes[1].text);
    assert.equal(moved.scenes[1].text, exampleStory.scenes[0].text);
  });

  it("applies cheap raw text guards before candidate evaluation", () => {
    assert.equal(
      validateRawVisualTitle("a".repeat(MAX_BROWSER_TITLE_CODE_UNITS)),
      null,
    );
    assert.match(
      validateRawVisualTitle(
        "a".repeat(MAX_BROWSER_TITLE_CODE_UNITS + 1),
      ),
      /not accepted/,
    );
    assert.equal(
      validateRawVisualCaption(
        "😀".repeat(MAX_VISUAL_CAPTION_CODE_UNITS / 2),
      ),
      null,
    );
    assert.match(
      validateRawVisualCaption("a".repeat(MAX_VISUAL_CAPTION_CODE_UNITS + 1)),
      /not accepted/,
    );
  });
});
