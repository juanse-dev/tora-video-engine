import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  countScenesUsingRef,
  deleteConfirmButtonLabel,
  deleteConfirmationText,
  describeMissingLocalAsset,
  evaluateMatchingFile,
  localOnlyDisclosure,
  mismatchDialogText,
  sceneNumbersUsingRef,
  usedByScenesText,
} from "../src/web/localAssetUi.ts";

const digest = `abcd${"0".repeat(56)}7890`;
const otherDigest = `1234${"f".repeat(56)}5678`;
const poseRef = `local:pose:sha256:${digest}`;
const backgroundRef = `local:background:sha256:${digest}`;
const otherPoseRef = `local:pose:sha256:${otherDigest}`;

const scene = (pose, background) => ({
  type: "dialogue",
  pose,
  background,
});
const story = (...scenes) => ({title: "T", scenes});

describe("ASSET-003 scene usage counts", () => {
  it("counts scenes, not fields", () => {
    const s = story(
      scene(poseRef, "office"),
      scene("formal", "office"),
      scene(poseRef, "server-room"),
    );

    assert.equal(countScenesUsingRef(s, poseRef), 2);
    assert.deepEqual(sceneNumbersUsingRef(s, poseRef), [1, 3]);
  });

  it("ignores the other category's ref with the same digest", () => {
    const s = story(scene(poseRef, backgroundRef), scene("formal", backgroundRef));

    assert.equal(countScenesUsingRef(s, poseRef), 1);
    assert.equal(countScenesUsingRef(s, backgroundRef), 2);
    assert.equal(countScenesUsingRef(s, otherPoseRef), 0);
    assert.deepEqual(sceneNumbersUsingRef(s, otherPoseRef), []);
  });
});

describe("ASSET-003 matching file evaluation", () => {
  it("matches the same ref", () => {
    assert.deepEqual(evaluateMatchingFile(poseRef, poseRef), {kind: "match"});
  });

  it("reports a different image for the same digest in another category", () => {
    assert.deepEqual(evaluateMatchingFile(poseRef, backgroundRef), {
      kind: "different",
      candidateRef: backgroundRef,
    });
  });

  it("reports a different image for another digest", () => {
    assert.deepEqual(evaluateMatchingFile(poseRef, otherPoseRef), {
      kind: "different",
      candidateRef: otherPoseRef,
    });
  });
});

describe("ASSET-003 copy", () => {
  it("returns the local-only disclosure for the page origin", () => {
    assert.equal(
      localOnlyDisclosure("https://tora.example"),
      "Stored only in this browser for https://tora.example. Not uploaded or synced. Production, Deploy Previews and localhost each keep a separate library.",
    );
  });

  it("returns the delete confirmation for an unused asset", () => {
    assert.equal(
      deleteConfirmationText("My cat", "pose", 0),
      'Delete "My cat" (pose) from My assets?',
    );
    assert.equal(deleteConfirmButtonLabel(0), "Delete asset");
  });

  it("returns the delete confirmation for an asset in use, singular and plural", () => {
    const tail =
      "Deleting it leaves those scenes with a missing local asset, and MP4 rendering stays blocked until you re-import the same file or choose a replacement. Other exported YAML files may also use it.";

    assert.equal(
      deleteConfirmationText("My cat", "pose", 1),
      `"My cat" (pose) is used by 1 scene in this Story. ${tail}`,
    );
    assert.equal(
      deleteConfirmationText("Sky", "background", 3),
      `"Sky" (background) is used by 3 scenes in this Story. ${tail}`,
    );
    assert.equal(deleteConfirmButtonLabel(1), "Delete asset anyway");
    assert.equal(deleteConfirmButtonLabel(3), "Delete asset anyway");
  });

  it("lists the scenes that use a missing asset", () => {
    assert.equal(usedByScenesText([2]), "Used by scene 2.");
    assert.equal(usedByScenesText([1, 3]), "Used by scenes 1, 3.");
    assert.equal(usedByScenesText([]), "Not used by any scene in this Story.");
  });

  it("describes a missing local asset card", () => {
    assert.deepEqual(
      describeMissingLocalAsset({ref: poseRef, sceneNumbers: [1, 3], damaged: false}),
      {
        title: "Missing local pose",
        shortId: "abcd…7890",
        usedBy: "Used by scenes 1, 3.",
        hint: "Import the original file to restore it, or pick any other pose to replace it.",
        damagedNote: null,
      },
    );
  });

  it("describes a corrupt local asset card with the damaged note", () => {
    assert.deepEqual(
      describeMissingLocalAsset({ref: backgroundRef, sceneNumbers: [2], damaged: true}),
      {
        title: "Missing local background",
        shortId: "abcd…7890",
        usedBy: "Used by scene 2.",
        hint: "Import the original file to restore it, or pick any other background to replace it.",
        damagedNote: "The stored copy is damaged.",
      },
    );
  });

  it("returns the mismatch dialog text", () => {
    assert.equal(
      mismatchDialogText(otherPoseRef),
      "This file is a different image (1234…5678), so it can't restore the missing one.",
    );
  });
});
