import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  buildLocalAssetRef,
  imageAssetCategories,
  isImageAssetCategory,
  isLocalAssetRef,
  isLocalAudioRef,
  isLocalPoseRef,
  localAssetCategories,
  parseLocalAssetRef,
} from "../src/localAssets/refs.ts";

const digest = "0123456789abcdef".repeat(4);

describe("local audio refs", () => {
  it("accepts the canonical audio ref", () => {
    const ref = `local:audio:sha256:${digest}`;
    assert.equal(isLocalAudioRef(ref), true);
    assert.equal(isLocalAssetRef(ref), true);
    assert.equal(isLocalPoseRef(ref), false);
    assert.deepEqual(parseLocalAssetRef(ref), {category: "audio", digest});
    assert.equal(buildLocalAssetRef("audio", digest), ref);
  });

  it("rejects uppercase hex, short digests and other prefixes", () => {
    for (const value of [
      `local:audio:sha256:${digest.toUpperCase()}`,
      `local:audio:sha256:${digest.slice(1)}`,
      `local:sound:sha256:${digest}`,
      `local:audio:md5:${digest}`,
      ` local:audio:sha256:${digest}`,
    ]) {
      assert.equal(isLocalAudioRef(value), false, value);
      assert.equal(parseLocalAssetRef(value), null, value);
    }
  });

  it("lists audio as a local category but not as an image category", () => {
    assert.deepEqual([...localAssetCategories], ["pose", "background", "audio"]);
    assert.deepEqual([...imageAssetCategories], ["pose", "background"]);
    assert.equal(isImageAssetCategory("audio"), false);
    assert.equal(isImageAssetCategory("pose"), true);
  });
});
