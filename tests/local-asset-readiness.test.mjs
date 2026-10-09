import assert from "node:assert/strict";
import test from "node:test";

import {
  describeBudgetFailure,
  evaluateLocalAssetBudget,
  collectStoryLocalAssetUsages,
  storyHasLocalAssetRefs,
} from "../src/localAssets/readiness.ts";
import {
  MAX_BROWSER_STORY_LOCAL_ASSET_BYTES,
  MAX_BROWSER_STORY_LOCAL_ASSET_PIXELS,
  MAX_BROWSER_STORY_LOCAL_ASSET_REFS,
} from "../src/localAssets/limits.ts";

const digestOf = (n) => n.toString(16).padStart(64, "0");
const poseRef = (n) => `local:pose:sha256:${digestOf(n)}`;
const backgroundRef = (n) => `local:background:sha256:${digestOf(n)}`;

const storyOf = (scenes) => ({
  title: "Readiness",
  scenes: scenes.map(([pose, background]) => ({
    pose,
    background,
    duration: 1,
    caption: "x",
  })),
});

const usageOf = (n, category = "pose") => ({
  ref: category === "pose" ? poseRef(n) : backgroundRef(n),
  category,
  digest: digestOf(n),
  sceneIndexes: [0],
});

const metadata = (byteSize, width = 1, height = 1) => ({
  mimeType: "image/png",
  byteSize,
  width,
  height,
});

test("usages deduplicate repeated refs and list scene indexes", () => {
  const story = storyOf([
    [poseRef(1), "office"],
    ["formal", backgroundRef(2)],
    [poseRef(1), backgroundRef(2)],
    [poseRef(3), "office"],
  ]);

  assert.deepEqual(collectStoryLocalAssetUsages(story), [
    {ref: poseRef(1), category: "pose", digest: digestOf(1), sceneIndexes: [0, 2]},
    {
      ref: backgroundRef(2),
      category: "background",
      digest: digestOf(2),
      sceneIndexes: [1, 2],
    },
    {ref: poseRef(3), category: "pose", digest: digestOf(3), sceneIndexes: [3]},
  ]);
});

test("usages are ordered by first appearance with pose before background", () => {
  const story = storyOf([[poseRef(9), backgroundRef(1)]]);

  assert.deepEqual(
    collectStoryLocalAssetUsages(story).map((usage) => usage.ref),
    [poseRef(9), backgroundRef(1)],
  );
});

test("the same digest as pose and as background yields two usages", () => {
  const story = storyOf([[poseRef(5), backgroundRef(5)]]);
  const usages = collectStoryLocalAssetUsages(story);

  assert.equal(usages.length, 2);
  assert.deepEqual(
    usages.map((usage) => [usage.category, usage.digest, usage.sceneIndexes]),
    [
      ["pose", digestOf(5), [0]],
      ["background", digestOf(5), [0]],
    ],
  );
});

test("bundled-only stories have no usages", () => {
  const story = storyOf([
    ["formal", "office"],
    ["coffee", "server-room"],
  ]);

  assert.deepEqual(collectStoryLocalAssetUsages(story), []);
  assert.equal(storyHasLocalAssetRefs(story), false);
});

test("storyHasLocalAssetRefs detects a local pose or background", () => {
  assert.equal(storyHasLocalAssetRefs(storyOf([[poseRef(1), "office"]])), true);
  assert.equal(
    storyHasLocalAssetRefs(
      storyOf([
        ["formal", "office"],
        ["formal", backgroundRef(1)],
      ]),
    ),
    true,
  );
});

test("budget passes at 64 refs and fails at 65", () => {
  const at = (count) =>
    evaluateLocalAssetBudget(
      Array.from({length: count}, (_, i) => usageOf(i + 1)),
      new Map(),
    );

  assert.equal(MAX_BROWSER_STORY_LOCAL_ASSET_REFS, 64);
  assert.deepEqual(at(64), {ok: true, refCount: 64, totalBytes: 0, totalPixels: 0});
  assert.deepEqual(at(65), {
    ok: false,
    refCount: 65,
    totalBytes: 0,
    totalPixels: 0,
    exceeded: ["refs"],
  });
});

test("budget passes at exactly 256 MiB and fails one byte above", () => {
  const usages = [usageOf(1), usageOf(2)];
  const half = MAX_BROWSER_STORY_LOCAL_ASSET_BYTES / 2;
  const atLimit = evaluateLocalAssetBudget(
    usages,
    new Map([
      [digestOf(1), metadata(half)],
      [digestOf(2), metadata(half)],
    ]),
  );
  const over = evaluateLocalAssetBudget(
    usages,
    new Map([
      [digestOf(1), metadata(half)],
      [digestOf(2), metadata(half + 1)],
    ]),
  );

  assert.equal(atLimit.ok, true);
  assert.equal(atLimit.totalBytes, MAX_BROWSER_STORY_LOCAL_ASSET_BYTES);
  assert.equal(over.ok, false);
  assert.deepEqual(over.exceeded, ["bytes"]);
  assert.equal(over.totalBytes, MAX_BROWSER_STORY_LOCAL_ASSET_BYTES + 1);
});

test("budget passes at exactly 200 MP and fails one pixel above", () => {
  const usages = [usageOf(1), usageOf(2)];
  const half = MAX_BROWSER_STORY_LOCAL_ASSET_PIXELS / 2;
  const atLimit = evaluateLocalAssetBudget(
    usages,
    new Map([
      [digestOf(1), metadata(1, half, 1)],
      [digestOf(2), metadata(1, half, 1)],
    ]),
  );
  const over = evaluateLocalAssetBudget(
    usages,
    new Map([
      [digestOf(1), metadata(1, half, 1)],
      [digestOf(2), metadata(1, half + 1, 1)],
    ]),
  );

  assert.equal(atLimit.ok, true);
  assert.equal(atLimit.totalPixels, MAX_BROWSER_STORY_LOCAL_ASSET_PIXELS);
  assert.equal(over.ok, false);
  assert.deepEqual(over.exceeded, ["pixels"]);
  assert.equal(over.totalPixels, MAX_BROWSER_STORY_LOCAL_ASSET_PIXELS + 1);
});

test("missing metadata counts toward refs but not bytes or pixels", () => {
  const result = evaluateLocalAssetBudget(
    [usageOf(1), usageOf(2), usageOf(3, "background")],
    new Map([[digestOf(2), metadata(100, 10, 20)]]),
  );

  assert.deepEqual(result, {
    ok: true,
    refCount: 3,
    totalBytes: 100,
    totalPixels: 200,
  });
});

test("two refs sharing a digest count its bytes and pixels once", () => {
  const result = evaluateLocalAssetBudget(
    [usageOf(7, "pose"), usageOf(7, "background")],
    new Map([[digestOf(7), metadata(1000, 30, 40)]]),
  );

  assert.deepEqual(result, {
    ok: true,
    refCount: 2,
    totalBytes: 1000,
    totalPixels: 1200,
  });
});

test("several exceeded limits are all listed", () => {
  const usages = Array.from({length: 65}, (_, i) => usageOf(i + 1));
  const result = evaluateLocalAssetBudget(
    usages,
    new Map([
      [
        digestOf(1),
        metadata(
          MAX_BROWSER_STORY_LOCAL_ASSET_BYTES + 1,
          MAX_BROWSER_STORY_LOCAL_ASSET_PIXELS + 1,
          1,
        ),
      ],
    ]),
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.exceeded, ["refs", "bytes", "pixels"]);
});

test("describeBudgetFailure writes one sentence per exceeded limit", () => {
  const usages = Array.from({length: 70}, (_, i) => usageOf(i + 1));
  const refsOnly = evaluateLocalAssetBudget(usages, new Map());

  assert.equal(refsOnly.ok, false);
  assert.equal(describeBudgetFailure(refsOnly), "Uses 70 local assets (limit 64).");

  const all = evaluateLocalAssetBudget(
    usages,
    new Map([
      [
        digestOf(1),
        metadata(
          MAX_BROWSER_STORY_LOCAL_ASSET_BYTES + 1024 * 1024,
          MAX_BROWSER_STORY_LOCAL_ASSET_PIXELS + 1_000_000,
          1,
        ),
      ],
    ]),
  );
  const sentences = describeBudgetFailure(all).split(/(?<=\.)\s+/u);

  assert.equal(sentences.length, 3);
  assert.equal(sentences[0], "Uses 70 local assets (limit 64).");
  assert.match(sentences[1], /257 MiB.*limit 256 MiB/u);
  assert.match(sentences[2], /201 megapixels.*limit 200 megapixels/u);
});
