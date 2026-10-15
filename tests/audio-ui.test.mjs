import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {formatAudioDuration} from "../src/audio/formatDuration.ts";
import {collectStoryLocalAssetUsages} from "../src/localAssets/readiness.ts";
import {
  activeStoryAudioUsage,
  audioRefUsesMusic,
  deleteConfirmationText,
  deleteConfirmButtonLabel,
  describeMissingLocalAsset,
  fileAcceptFor,
  mismatchDialogText,
  sceneNumbersUsingAudioRef,
  usedByScenesText,
} from "../src/web/localAssetUi.ts";

const ref = (n) => `local:audio:sha256:${n.toString(16).padStart(64, "0")}`;
const poseRef = `local:pose:sha256:${"1".padStart(64, "0")}`;

describe("formatAudioDuration", () => {
  it("rounds to whole seconds, never shows 0:00 for a positive duration, and handles bad input", () => {
    const cases = [
      [0.12, "0:01"], [0.4, "0:01"], [2.2, "0:02"], [2.6, "0:03"], [59.5, "1:00"], [59.6, "1:00"], [125, "2:05"],
      [163.84, "2:44"], [300, "5:00"], [0, "0:00"], [-1, "0:00"], [Number.NaN, "0:00"], [Number.POSITIVE_INFINITY, "0:00"],
    ];

    for (const [seconds, text] of cases) {
      assert.equal(formatAudioDuration(seconds), text, String(seconds));
    }
  });
});

describe("audio usage in the Story", () => {
  const story = {
    music: {src: ref(1)},
    scenes: [{sfx: {src: ref(2)}}, {voice: {src: ref(2)}}, {sfx: {src: ref(3)}, voice: {src: ref(2)}}, {}],
  };

  it("counts scenes by sfx or voice (any audio role except the Story's music)", () => {
    assert.deepEqual(sceneNumbersUsingAudioRef(story, ref(2)), [1, 2, 3]);
    assert.deepEqual(sceneNumbersUsingAudioRef(story, ref(3)), [3]);
    assert.deepEqual(sceneNumbersUsingAudioRef(story, ref(1)), []);
    assert.equal(audioRefUsesMusic(story, ref(1)), true);
    assert.equal(audioRefUsesMusic(story, ref(2)), false);
    assert.equal(audioRefUsesMusic({scenes: []}, ref(1)), false);
  });
});

describe("copy for audio", () => {
  it("usedByScenesText mentions the music and leaves the image text alone", () => {
    assert.equal(usedByScenesText([]), "Not used by any scene in this Story.");
    assert.equal(usedByScenesText([1, 3]), "Used by scenes 1, 3.");
    assert.equal(usedByScenesText([2]), "Used by scene 2.");
    assert.equal(usedByScenesText([], true), "Used by the music.");
    assert.equal(usedByScenesText([2], true), "Used by the music and 1 scene.");
    assert.equal(usedByScenesText([1, 3], true), "Used by the music and 2 scenes.");
  });

  it("deleteConfirmationText: images unchanged, audio uses the AUDIO-004 wording across roles", () => {
    assert.equal(deleteConfirmationText("Hero", "pose", 0), 'Delete "Hero" (pose) from My assets?');
    assert.match(deleteConfirmationText("Hero", "pose", 2), /^"Hero" \(pose\) is used by 2 scenes in this Story\. Deleting it leaves those scenes with a missing local asset/u);
    assert.equal(deleteConfirmationText("Voice", "audio", 0), 'Delete "Voice" (audio) from My audio?');
    assert.equal(deleteConfirmationText("Voice", "audio", 0, false), 'Delete "Voice" (audio) from My audio?');

    const tail = "Deleting it removes that sound from the preview, and MP4 rendering stays blocked until you re-import the same file or choose a replacement. Other exported YAML files may also use it.";

    assert.equal(deleteConfirmationText("Voice", "audio", 2, false, [1, 3]), `Delete "Voice" (audio)? Used by scenes 1, 3. ${tail}`);
    assert.equal(deleteConfirmationText("Voice", "audio", 1, false, [3]), `Delete "Voice" (audio)? Used by scene 3. ${tail}`);
    assert.equal(deleteConfirmationText("Voice", "audio", 0, true), `Delete "Voice" (audio)? Used by the music. ${tail}`);
    assert.equal(deleteConfirmationText("Voice", "audio", 2, true, [1, 2]), `Delete "Voice" (audio)? Used by the music and 2 scenes. ${tail}`);
    assert.equal(deleteConfirmationText("Voice", "audio", 1, true, [3]), `Delete "Voice" (audio)? Used by the music and 1 scene. ${tail}`);
    assert.equal(deleteConfirmButtonLabel(0), "Delete asset");
    assert.equal(deleteConfirmButtonLabel(1), "Delete asset anyway");
  });

  it("describeMissingLocalAsset: audio has no replacement picker yet", () => {
    const audio = describeMissingLocalAsset({ref: ref(5), sceneNumbers: [1, 2], damaged: false, usesMusic: true});

    assert.equal(audio.title, "Missing local audio");
    assert.equal(audio.usedBy, "Used by the music and 2 scenes.");
    assert.equal(audio.hint, "Import the original file to restore it.");
    assert.equal(audio.damagedNote, null);
    assert.equal(describeMissingLocalAsset({ref: ref(5), sceneNumbers: [], damaged: true}).damagedNote, "The stored copy is damaged.");

    const image = describeMissingLocalAsset({ref: poseRef, sceneNumbers: [1], damaged: false});

    assert.equal(image.title, "Missing local pose");
    assert.equal(image.hint, "Import the original file to restore it, or pick any other pose to replace it.");
  });

  it("the mismatch text names the kind of file, and the file pickers accept the right types", () => {
    assert.match(mismatchDialogText(poseRef), /^This file is a different image \(/u);
    assert.match(mismatchDialogText(ref(7)), /^This file is a different audio file \(/u);
    assert.equal(fileAcceptFor("pose"), "image/png,image/jpeg,image/webp");
    assert.match(fileAcceptFor("audio"), /\.mp3.*\.wav.*\.m4a.*\.ogg/u);
  });
});

describe("a missing card counts the Active Story's usage (AUDIO-003 follow-up)", () => {
  const scene = (extra = {}) => ({type: "intro", pose: "formal", background: "office", text: "Hi", duration: 3, ...extra});
  const active = {
    title: "Active",
    music: {src: ref(1)},
    scenes: [scene({voice: {src: ref(1)}}), scene(), scene({sfx: {src: ref(1)}, voice: {src: ref(2)}})],
  };
  const usageOf = (story, audioRef) =>
    collectStoryLocalAssetUsages(story).find((usage) => usage.ref === audioRef);

  it("reads the scene numbers and the music from the collector's usage", () => {
    assert.deepEqual(activeStoryAudioUsage(usageOf(active, ref(1))), {sceneNumbers: [1, 3], usesMusic: true});
    assert.deepEqual(activeStoryAudioUsage(usageOf(active, ref(2))), {sceneNumbers: [3], usesMusic: false});
  });

  it("feeds the existing copy: music and 2 scenes, scene 3, and the image case stays empty", () => {
    const text = (audioRef) =>
      describeMissingLocalAsset({ref: audioRef, damaged: false, ...activeStoryAudioUsage(usageOf(active, audioRef))}).usedBy;

    assert.equal(text(ref(1)), "Used by the music and 2 scenes.");
    assert.equal(text(ref(2)), "Used by scene 3.");

    const pose = usageOf({title: "T", scenes: [scene({pose: poseRef})]}, poseRef);

    assert.deepEqual(activeStoryAudioUsage(pose), {sceneNumbers: [], usesMusic: false});
  });

  it("a pending visual draft changes the delete warning of a card but never the missing card", () => {
    // The draft dropped the music and the voice of scene 1 (pending, so the Active Story is unchanged).
    const draft = {music: undefined, scenes: [scene(), scene(), scene({sfx: {src: ref(1)}})]};
    const deleteWarning = deleteConfirmationText(
      "Voice",
      "audio",
      sceneNumbersUsingAudioRef(draft, ref(1)).length,
      audioRefUsesMusic(draft, ref(1)),
      sceneNumbersUsingAudioRef(draft, ref(1)),
    );
    const missing = describeMissingLocalAsset({
      ref: ref(1),
      damaged: false,
      ...activeStoryAudioUsage(usageOf(active, ref(1))),
    }).usedBy;

    assert.match(deleteWarning, /Used by scene 3\./u);
    assert.equal(missing, "Used by the music and 2 scenes.");
  });
});
