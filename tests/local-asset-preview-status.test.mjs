import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {describeLocalAssetPreviewStatus} from "../src/web/localAssetPreviewStatus.ts";

const digest = (n) => n.toString(16).padStart(64, "0");
const imageEntry = (n, sceneIndexes, status = "missing", detail = null) => ({
  usage: {ref: `local:pose:sha256:${digest(n)}`, category: "pose", digest: digest(n), sceneIndexes},
  status,
  detail,
});
const audioEntry = (n, status = "missing", detail = null) => ({
  usage: {ref: `local:audio:sha256:${digest(n)}`, category: "audio", digest: digest(n), sceneIndexes: [0], roles: ["voice"]},
  status,
  detail,
});
const resolved = (refs, failureMessage = null) => ({kind: "resolved", refs, verified: new Map(), blobs: new Map(), allReady: false, failureMessage});

describe("describeLocalAssetPreviewStatus", () => {
  it("is null for anything but a resolved state with a ref that is not ready", () => {
    assert.equal(describeLocalAssetPreviewStatus(undefined), null);
    assert.equal(describeLocalAssetPreviewStatus({kind: "none"}), null);
    assert.equal(describeLocalAssetPreviewStatus(resolved([imageEntry(1, [0], "ready")])), null);
  });

  it("keeps the v0.3 sentences for images", () => {
    assert.equal(
      describeLocalAssetPreviewStatus(resolved([imageEntry(1, [0, 2]), imageEntry(2, [2])])),
      "2 local assets are missing in this browser. Scenes 1, 3 show placeholders.",
    );
    assert.equal(
      describeLocalAssetPreviewStatus(resolved([imageEntry(1, [1], "unavailable", "Storage is closed.")])),
      "1 local asset is unavailable in this browser. Scene 2 shows a placeholder. Storage is closed.",
    );
  });

  it("describes audio without mentioning placeholders", () => {
    assert.equal(
      describeLocalAssetPreviewStatus(resolved([audioEntry(1)])),
      "1 local audio file is missing in this browser. Its sound is not played.",
    );
    assert.equal(
      describeLocalAssetPreviewStatus(resolved([audioEntry(1, "corrupt"), audioEntry(2, "unavailable", "Closed.")])),
      "2 local audio files are missing in this browser. Their sounds are not played. Closed.",
    );
  });

  it("reports images first, then audio, when both are not ready", () => {
    assert.equal(
      describeLocalAssetPreviewStatus(resolved([imageEntry(1, [0]), audioEntry(2)])),
      "1 local asset is missing in this browser. Scene 1 shows a placeholder. 1 local audio file is missing in this browser. Its sound is not played.",
    );
  });
});
