import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";
import {resolve} from "node:path";
import {describe, it} from "node:test";
import {
  backgroundAssets,
  backgroundCatalog,
  isBundledBackground,
  isBundledPose,
  toraPoseAssets,
  toraPoseCatalog,
} from "../src/assets.ts";
import {
  MAX_BROWSER_STORY_LOCAL_ASSET_BYTES,
  MAX_BROWSER_STORY_LOCAL_ASSET_PIXELS,
  MAX_BROWSER_STORY_LOCAL_ASSET_REFS,
  MAX_LOCAL_ASSET_BYTES,
  MAX_LOCAL_ASSET_DIMENSION,
  MAX_LOCAL_ASSET_PIXELS,
} from "../src/localAssets/limits.ts";
import {
  LOCAL_ASSET_REF_PATTERN,
  SHA256_HEX_PATTERN,
  buildLocalAssetRef,
  isLocalAssetRef,
  isLocalBackgroundRef,
  isLocalPoseRef,
  localAssetCategories,
  localAssetRefPrefix,
  parseLocalAssetRef,
} from "../src/localAssets/refs.ts";
import {exampleStory} from "../src/story/exampleStory.ts";
import {parseStorySource} from "../src/story/parseStory.ts";
import {StorySchema} from "../src/story/schema.ts";
import {serializeStorySource} from "../src/story/serializeStory.ts";

const digest = "0123456789abcdef".repeat(4);
const otherDigest = "fedcba9876543210".repeat(4);
const poseRef = `local:pose:sha256:${digest}`;
const backgroundRef = `local:background:sha256:${otherDigest}`;

const source = (pose, background) => `title: Test
scenes:
  - type: intro
    pose: ${pose}
    background: ${background}
    text: Test
    duration: 1
`;

const parseIssues = (pose, background) => {
  const result = StorySchema.safeParse({
    title: "Test",
    scenes: [{type: "intro", pose, background, text: "Test", duration: 1}],
  });

  assert.equal(result.success, false);
  return result.error.issues;
};

describe("limits", () => {
  it("exposes the README constants", () => {
    assert.equal(MAX_LOCAL_ASSET_BYTES, 25 * 1024 * 1024);
    assert.equal(MAX_LOCAL_ASSET_DIMENSION, 8192);
    assert.equal(MAX_LOCAL_ASSET_PIXELS, 50_000_000);
    assert.equal(MAX_BROWSER_STORY_LOCAL_ASSET_REFS, 64);
    assert.equal(MAX_BROWSER_STORY_LOCAL_ASSET_BYTES, 256 * 1024 * 1024);
    assert.equal(MAX_BROWSER_STORY_LOCAL_ASSET_PIXELS, 200_000_000);
  });
});

describe("existing fixtures", () => {
  it("still parse unchanged", async () => {
    const files = (await readdir(resolve("stories"))).filter((name) =>
      name.endsWith(".yaml"),
    );

    assert.ok(files.length > 0);

    for (const file of files) {
      const text = await readFile(resolve("stories", file), "utf8");
      assert.doesNotThrow(() => parseStorySource(text, file), file);
    }

    assert.equal(StorySchema.safeParse(exampleStory).success, true);
  });
});

describe("story schema with local refs", () => {
  it("accepts a local pose ref and a local background ref", () => {
    const story = parseStorySource(source(poseRef, backgroundRef));

    assert.equal(story.scenes[0].pose, poseRef);
    assert.equal(story.scenes[0].background, backgroundRef);
  });

  it("rejects cross-category refs with the custom message", () => {
    const poseIssues = parseIssues(backgroundRef, "office");
    const backgroundIssues = parseIssues("formal", poseRef);

    assert.equal(
      poseIssues[0].message,
      "Pose must be formal, confused, panic, coffee, or local:pose:sha256:<64 lowercase hex>",
    );
    assert.equal(
      backgroundIssues[0].message,
      "Background must be office, server-room, or local:background:sha256:<64 lowercase hex>",
    );
  });

  it("rejects malformed refs", () => {
    const malformed = [
      `local:pose:sha256:${digest.toUpperCase()}`,
      `local:pose:sha256:${digest.slice(1)}`,
      `local:pose:sha256:${digest}0`,
      `local:pose:sha1:${digest}`,
      `local:sprite:sha256:${digest}`,
      ` ${poseRef}`,
      `${poseRef} `,
      `${poseRef}\n`,
      "local:pose:sha256:",
      "local:pose:sha256",
      "",
    ];

    for (const value of malformed) {
      const issues = parseIssues(value, "office");
      assert.match(issues[0].message, /^Pose must be /u, JSON.stringify(value));
    }
  });

  it("rejects non-string values", () => {
    for (const value of [1, null, undefined, {}, []]) {
      parseIssues(value, "office");
    }
  });

  it("round-trips local refs byte-identically through YAML as plain scalars", () => {
    const story = parseStorySource(source(poseRef, backgroundRef));
    const yaml = serializeStorySource(story);

    assert.ok(yaml.includes(`pose: ${poseRef}\n`));
    assert.ok(yaml.includes(`background: ${backgroundRef}\n`));
    assert.ok(!yaml.includes('"'));
    assert.ok(!yaml.includes("'"));

    const reparsed = parseStorySource(yaml);
    assert.deepEqual(reparsed, story);
    assert.equal(serializeStorySource(reparsed), yaml);
  });
});

describe("ref helpers", () => {
  it("exposes the grammar", () => {
    assert.deepEqual([...localAssetCategories], ["pose", "background"]);
    assert.equal(
      LOCAL_ASSET_REF_PATTERN.source,
      "^local:(pose|background):sha256:[0-9a-f]{64}$",
    );
    assert.equal(SHA256_HEX_PATTERN.source, "^[0-9a-f]{64}$");
    assert.equal(localAssetRefPrefix("pose"), "local:pose:sha256:");
    assert.equal(localAssetRefPrefix("background"), "local:background:sha256:");
  });

  it("guards by category", () => {
    assert.equal(isLocalAssetRef(poseRef), true);
    assert.equal(isLocalAssetRef(backgroundRef), true);
    assert.equal(isLocalAssetRef("formal"), false);
    assert.equal(isLocalPoseRef(poseRef), true);
    assert.equal(isLocalPoseRef(backgroundRef), false);
    assert.equal(isLocalBackgroundRef(backgroundRef), true);
    assert.equal(isLocalBackgroundRef(poseRef), false);
  });

  it("parses and builds round-trip", () => {
    assert.deepEqual(parseLocalAssetRef(poseRef), {
      category: "pose",
      digest,
    });
    assert.deepEqual(parseLocalAssetRef(backgroundRef), {
      category: "background",
      digest: otherDigest,
    });
    assert.equal(parseLocalAssetRef("formal"), null);
    assert.equal(parseLocalAssetRef(` ${poseRef}`), null);
    assert.equal(parseLocalAssetRef(`${poseRef}\n`), null);
    assert.equal(buildLocalAssetRef("pose", digest), poseRef);
    assert.equal(buildLocalAssetRef("background", otherDigest), backgroundRef);

    for (const ref of [poseRef, backgroundRef]) {
      const parsed = parseLocalAssetRef(ref);
      assert.equal(buildLocalAssetRef(parsed.category, parsed.digest), ref);
    }
  });

  it("buildLocalAssetRef throws on a bad digest or category", () => {
    for (const bad of [
      digest.toUpperCase(),
      digest.slice(1),
      `${digest}0`,
      "",
      `${digest}\n`,
    ]) {
      assert.throws(() => buildLocalAssetRef("pose", bad), /digest/iu);
    }

    assert.throws(() => buildLocalAssetRef("sprite", digest));
  });
});

describe("bundled catalogs", () => {
  it("contain exactly the bundled keys", () => {
    assert.deepEqual(Object.keys(toraPoseCatalog), [
      "formal",
      "confused",
      "panic",
      "coffee",
    ]);
    assert.deepEqual(Object.keys(backgroundCatalog), ["office", "server-room"]);
    assert.deepEqual(Object.keys(toraPoseAssets), Object.keys(toraPoseCatalog));
    assert.deepEqual(
      Object.keys(backgroundAssets),
      Object.keys(backgroundCatalog),
    );
  });

  it("guards bundled values and rejects local refs", () => {
    assert.equal(isBundledPose("formal"), true);
    assert.equal(isBundledPose("office"), false);
    assert.equal(isBundledPose(poseRef), false);
    assert.equal(isBundledPose("toString"), false);
    assert.equal(isBundledBackground("office"), true);
    assert.equal(isBundledBackground("formal"), false);
    assert.equal(isBundledBackground(backgroundRef), false);
    assert.equal(isBundledBackground("constructor"), false);
  });
});
