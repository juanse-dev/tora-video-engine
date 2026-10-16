import assert from "node:assert/strict";
import test from "node:test";

import {
  describeBudgetFailure,
  evaluateLocalAssetBudget,
  collectStoryLocalAssetUsages,
  splitUsagesByCategory,
  storyHasLocalAssetRefs,
} from "../src/localAssets/readiness.ts";
import {
  describeAudioBudgetFailure,
  evaluateAudioBudget,
} from "../src/audio/readiness.ts";
import {
  MAX_BROWSER_STORY_AUDIO_BYTES,
  MAX_BROWSER_STORY_AUDIO_REFS,
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

test("the budget fails closed on non-image metadata and names it", () => {
  const audio = {
    kind: "audio", mimeType: "audio/wav", byteSize: 1000, container: "wave", codec: "pcm",
    durationSeconds: 1, sampleRate: 48_000, channels: 2,
  };
  const result = evaluateLocalAssetBudget([usageOf(1)], new Map([[digestOf(1), audio]]));

  assert.equal(result.ok, false);
  assert.deepEqual(result.exceeded, ["metadata"]);
  assert.equal(describeBudgetFailure(result), "A local asset's stored details do not match an image.");
});

const audioRefOf = (n) => `local:audio:sha256:${digestOf(n)}`;
const withScenes = (story, patches) => ({
  ...story,
  scenes: story.scenes.map((scene, index) => ({...scene, ...patches[index]})),
});

test("the collector lists audio usages after the image usages, with roles and scene indexes", () => {
  const story = withScenes(
    {
      ...storyOf([[poseRef(1), "office"], ["formal", backgroundRef(2)], ["formal", "office"]]),
      music: {src: audioRefOf(9)},
    },
    [
      {sfx: {src: audioRefOf(3)}, voice: {src: audioRefOf(4)}},
      {sfx: {src: audioRefOf(9)}},
      {voice: {src: audioRefOf(4)}, sfx: {src: "boom"}},
    ],
  );

  assert.deepEqual(collectStoryLocalAssetUsages(story), [
    {ref: poseRef(1), category: "pose", digest: digestOf(1), sceneIndexes: [0]},
    {ref: backgroundRef(2), category: "background", digest: digestOf(2), sceneIndexes: [1]},
    {ref: audioRefOf(9), category: "audio", digest: digestOf(9), sceneIndexes: [1], roles: ["music", "sfx"]},
    {ref: audioRefOf(3), category: "audio", digest: digestOf(3), sceneIndexes: [0], roles: ["sfx"]},
    {ref: audioRefOf(4), category: "audio", digest: digestOf(4), sceneIndexes: [0, 2], roles: ["voice"]},
  ]);
});

test("bundled sounds are not local usages and an audio-only Story has no local image refs", () => {
  const story = withScenes(storyOf([["formal", "office"]]), [{sfx: {src: "boom"}, voice: {src: audioRefOf(1)}}]);

  assert.deepEqual(collectStoryLocalAssetUsages(story).map((usage) => usage.ref), [audioRefOf(1)]);
  assert.equal(storyHasLocalAssetRefs(story), false);
  assert.deepEqual(collectStoryLocalAssetUsages(withScenes(storyOf([["formal", "office"]]), [{sfx: {src: "boom"}}])), []);
});

test("splitUsagesByCategory feeds the image budget with image usages only", () => {
  const usages = collectStoryLocalAssetUsages(
    withScenes(storyOf([[poseRef(1), "office"]]), [{voice: {src: audioRefOf(2)}}]),
  );
  const split = splitUsagesByCategory(usages);

  assert.deepEqual(split.image.map((usage) => usage.ref), [poseRef(1)]);
  assert.deepEqual(split.audio.map((usage) => usage.ref), [audioRefOf(2)]);

  const result = evaluateLocalAssetBudget(split.image, new Map([[digestOf(1), metadata(100, 4, 5)]]));

  assert.deepEqual(result, {ok: true, refCount: 1, totalBytes: 100, totalPixels: 20});
});

// --- AUDIO-005: the audio budget ------------------------------------------------

const MIB = 1024 * 1024;

const audioUsageOf = (n) => ({
  ref: audioRefOf(n),
  category: "audio",
  digest: digestOf(n),
  sceneIndexes: [0],
  roles: ["voice"],
});

const audioMetadata = (byteSize) => ({
  kind: "audio",
  mimeType: "audio/wav",
  byteSize,
  container: "wave",
  codec: "pcm",
  durationSeconds: 10,
  sampleRate: 48_000,
  channels: 2,
});

test("the audio budget passes at 64 refs and fails at 65 with its own sentence", () => {
  const at = (count) =>
    evaluateAudioBudget(
      Array.from({length: count}, (_, i) => audioUsageOf(i + 1)),
      new Map(),
    );

  assert.equal(MAX_BROWSER_STORY_AUDIO_REFS, 64);
  assert.deepEqual(at(64), {ok: true, refCount: 64, totalBytes: 0, totalPixels: 0});

  const over = at(65);

  assert.equal(over.ok, false);
  assert.deepEqual(over.exceeded, ["refs"]);
  assert.equal(describeAudioBudgetFailure(over), "This Story uses more than 64 audio files.");
});

test("the audio budget sums bytes once per digest: 256 MiB passes, one byte more fails", () => {
  const usages = [1, 2, 3, 4].map(audioUsageOf);
  const at = (last) =>
    evaluateAudioBudget(
      [...usages, audioUsageOf(1)],
      new Map([
        [digestOf(1), audioMetadata(64 * MIB)],
        [digestOf(2), audioMetadata(64 * MIB)],
        [digestOf(3), audioMetadata(64 * MIB)],
        [digestOf(4), audioMetadata(last)],
      ]),
    );

  assert.equal(MAX_BROWSER_STORY_AUDIO_BYTES, 256 * MIB);
  assert.equal(at(64 * MIB).ok, true);
  assert.equal(at(64 * MIB).totalBytes, 256 * MIB);

  const over = at(64 * MIB + 1);

  assert.equal(over.ok, false);
  assert.deepEqual(over.exceeded, ["bytes"]);
  assert.equal(describeAudioBudgetFailure(over), "This Story's audio is larger than 256 MiB.");
});

test("each budget counts only its own refs and bytes", () => {
  const imageUsages = Array.from({length: 64}, (_, i) => usageOf(i + 1));
  const audioUsages = Array.from({length: 64}, (_, i) => audioUsageOf(500 + i));
  const imageMeta = new Map(imageUsages.map((u) => [u.digest, metadata(4 * MIB, 1000, 1000)]));
  const audioMeta = new Map(audioUsages.map((u) => [u.digest, audioMetadata(4 * MIB)]));
  const story = withScenes(
    storyOf(imageUsages.map((u) => [u.ref, "office"])),
    audioUsages.map((u) => ({voice: {src: u.ref}})),
  );
  const split = splitUsagesByCategory(collectStoryLocalAssetUsages(story));
  const all = new Map([...imageMeta, ...audioMeta]);

  // 64 + 64 refs, 256 MiB + 256 MiB: each budget is exactly at its limit.
  assert.deepEqual(evaluateLocalAssetBudget(split.image, all), {
    ok: true,
    refCount: 64,
    totalBytes: 256 * MIB,
    totalPixels: 64_000_000,
  });
  assert.deepEqual(evaluateAudioBudget(split.audio, all), {
    ok: true,
    refCount: 64,
    totalBytes: 256 * MIB,
    totalPixels: 0,
  });

  // One more of either kind fails only that kind.
  assert.equal(evaluateLocalAssetBudget([...split.image, usageOf(99)], all).ok, false);
  assert.equal(evaluateAudioBudget(split.audio, all).ok, true);
  assert.equal(evaluateAudioBudget([...split.audio, audioUsageOf(999)], all).ok, false);
  assert.equal(evaluateLocalAssetBudget(split.image, all).ok, true);
});

test("both budgets fail closed on metadata of the other kind, never adding NaN", () => {
  const image = metadata(1000);
  const imageResult = evaluateAudioBudget([audioUsageOf(1)], new Map([[digestOf(1), image]]));

  assert.equal(imageResult.ok, false);
  assert.deepEqual(imageResult.exceeded, ["metadata"]);
  assert.equal(imageResult.totalBytes, 0);
  assert.equal(
    describeAudioBudgetFailure(imageResult),
    "An audio file's stored details do not match an audio file.",
  );

  const audioResult = evaluateLocalAssetBudget(
    [usageOf(1)],
    new Map([[digestOf(1), audioMetadata(1000)]]),
  );

  assert.deepEqual(audioResult.exceeded, ["metadata"]);
  assert.equal(audioResult.totalPixels, 0);
});

test("image metadata without finite dimensions fails closed instead of making the pixel total NaN", () => {
  for (const bad of [
    {...metadata(1000), width: undefined},
    {...metadata(1000), height: Number.NaN},
    {...metadata(1000), width: Number.POSITIVE_INFINITY},
  ]) {
    const result = evaluateLocalAssetBudget([usageOf(1)], new Map([[digestOf(1), bad]]));

    assert.equal(result.ok, false);
    assert.deepEqual(result.exceeded, ["metadata"]);
    assert.equal(Number.isNaN(result.totalPixels), false);
  }
});
