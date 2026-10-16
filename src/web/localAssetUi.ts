import {
  parseLocalAssetRef,
  type LocalAssetCategory,
  type LocalAssetRef,
  type LocalAudioRef,
} from "../localAssets/refs.ts";
import type {LocalAssetUsage} from "../localAssets/readiness.ts";
import {shortAssetId} from "../localAssets/sources.ts";

/** What a scene count needs from a scene: a Story scene or a visual draft scene both fit. */
export type SceneAssetValues = {pose: string; background: string};

/**
 * 1-based numbers of the scenes whose pose or background equals ref. A ref
 * carries its category, so the other category's ref with the same digest never
 * matches.
 *
 * Pass the scenes the user is looking at: the visual editor's draft scenes
 * (which equal the Active Story's unless a draft is pending, and then show
 * what the pending draft uses), never the Active Story behind a pending draft.
 */
export const sceneNumbersUsingRef = (
  story: {readonly scenes: readonly SceneAssetValues[]},
  ref: LocalAssetRef,
): number[] =>
  story.scenes.flatMap((scene, index) =>
    scene.pose === ref || scene.background === ref ? [index + 1] : [],
  );

/** Number of scenes (not fields) that use ref; see sceneNumbersUsingRef for which scenes to pass. */
export const countScenesUsingRef = (
  story: {readonly scenes: readonly SceneAssetValues[]},
  ref: LocalAssetRef,
): number => sceneNumbersUsingRef(story, ref).length;

/** What an audio usage count needs from a scene: a Story scene or a visual draft scene both fit. */
export type SceneAudioValues = {
  readonly sfx?: {readonly src: string};
  readonly voice?: {readonly src: string};
};

/** 1-based numbers of the scenes whose sfx or voice equals ref (the Story's music has no scene). */
export const sceneNumbersUsingAudioRef = (
  story: {readonly scenes: readonly SceneAudioValues[]},
  ref: LocalAudioRef,
): number[] =>
  story.scenes.flatMap((scene, index) =>
    scene.sfx?.src === ref || scene.voice?.src === ref ? [index + 1] : [],
  );

/**
 * The Active Story's own usage of an audio ref, as the collector found it. A
 * missing card exists because the Active Story uses the ref, so its text is
 * counted from that same usage: a pending visual draft can neither hide the
 * problem it describes nor invent one. (The delete warning of a regular card
 * counts the visual draft instead, so a pending draft is never under-counted.)
 */
export const activeStoryAudioUsage = (
  usage: LocalAssetUsage,
): {sceneNumbers: number[]; usesMusic: boolean} =>
  usage.category === "audio"
    ? {
        sceneNumbers: usage.sceneIndexes.map((index) => index + 1),
        usesMusic: usage.roles.includes("music"),
      }
    : {sceneNumbers: [], usesMusic: false};

export const audioRefUsesMusic = (
  story: {readonly music?: {readonly src: string}},
  ref: LocalAudioRef,
): boolean => story.music?.src === ref;

const IMAGE_FILE_ACCEPT = "image/png,image/jpeg,image/webp";
const AUDIO_FILE_ACCEPT =
  "audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/ogg,.mp3,.wav,.m4a,.ogg,.opus";

/** The `accept` attribute of the import inputs. */
export const fileAcceptFor = (category: LocalAssetCategory): string =>
  category === "audio" ? AUDIO_FILE_ACCEPT : IMAGE_FILE_ACCEPT;

export type MatchingFileResult =
  | {kind: "match"} // same category + same digest
  | {kind: "different"; candidateRef: LocalAssetRef};

export const evaluateMatchingFile = (
  missingRef: LocalAssetRef,
  candidateRef: LocalAssetRef,
): MatchingFileResult =>
  missingRef === candidateRef
    ? {kind: "match"}
    : {kind: "different", candidateRef};

export const localOnlyDisclosure = (origin: string): string =>
  `Stored only in this browser for ${origin}. Not uploaded or synced. Production, Deploy Previews and localhost each keep a separate library.`;

// The spec writes "scene(s)"; the helpers pick "scene" for exactly one and
// "scenes" otherwise, so the copy reads naturally.
const scenesNoun = (count: number): string =>
  count === 1 ? "scene" : "scenes";

export const deleteConfirmationText = (
  label: string,
  category: LocalAssetCategory,
  sceneCount: number,
  usesMusic = false,
  sceneNumbers: readonly number[] = [],
): string => {
  if (category === "audio") {
    // The usage sentence is the AUDIO-004 wording: "Used by the music and 2 scenes." / "Used by scene 3."
    return sceneNumbers.length > 0 || usesMusic
      ? `Delete "${label}" (audio)? ${usedByScenesText(sceneNumbers, usesMusic)} Deleting it removes that sound from the preview, and MP4 rendering stays blocked until you re-import the same file or choose a replacement. Other exported YAML files may also use it.`
      : `Delete "${label}" (audio) from My audio?`;
  }

  return sceneCount === 0
    ? `Delete "${label}" (${category}) from My assets?`
    : `"${label}" (${category}) is used by ${sceneCount} ${scenesNoun(sceneCount)} in this Story. Deleting it leaves those scenes with a missing local asset, and MP4 rendering stays blocked until you re-import the same file or choose a replacement. Other exported YAML files may also use it.`;
};

export const deleteConfirmButtonLabel = (sceneCount: number): string =>
  sceneCount === 0 ? "Delete asset" : "Delete asset anyway";

/**
 * "Used by scene 2." / "Used by scenes 1, 3." for 1-based scene numbers; with the
 * Story's music: "Used by the music." / "Used by the music and 2 scenes."
 */
export const usedByScenesText = (
  sceneNumbers: readonly number[],
  usesMusic = false,
): string => {
  if (usesMusic) {
    return sceneNumbers.length === 0
      ? "Used by the music."
      : `Used by the music and ${sceneNumbers.length} ${scenesNoun(sceneNumbers.length)}.`;
  }

  return sceneNumbers.length === 0
    ? "Not used by any scene in this Story."
    : `Used by ${scenesNoun(sceneNumbers.length)} ${sceneNumbers.join(", ")}.`;
};

export type MissingLocalAssetCopy = {
  title: string;
  shortId: string;
  usedBy: string;
  hint: string;
  damagedNote: string | null;
};

/** Copy for the missing (damaged: false) or corrupt (damaged: true) current-selection card. */
export const describeMissingLocalAsset = ({
  ref,
  sceneNumbers,
  damaged,
  usesMusic = false,
}: {
  ref: LocalAssetRef;
  sceneNumbers: readonly number[];
  damaged: boolean;
  usesMusic?: boolean;
}): MissingLocalAssetCopy => {
  const parsed = parseLocalAssetRef(ref);

  if (parsed === null) {
    throw new Error(`Not a local asset ref: ${ref}`);
  }

  const {category} = parsed;

  return {
    title: `Missing local ${category}`,
    shortId: shortAssetId(ref),
    usedBy: usedByScenesText(sceneNumbers, usesMusic),
    hint:
      category === "audio"
        ? "Import the original file to restore it."
        : `Import the original file to restore it, or pick any other ${category} to replace it.`,
    damagedNote: damaged ? "The stored copy is damaged." : null,
  };
};

export const mismatchDialogText = (candidateRef: LocalAssetRef): string =>
  `This file is a different ${
    parseLocalAssetRef(candidateRef)?.category === "audio" ? "audio file" : "image"
  } (${shortAssetId(candidateRef)}), so it can't restore the missing one.`;

export type AssetDialogCallbackResult =
  | {ok: true}
  | {ok: false; message: string; error: unknown};

/**
 * Runs an asset dialog callback so that nothing escapes: a synchronous throw
 * or a rejection becomes `{ok: false}`, and `finalize` always runs after the
 * callback settles (used to clear the import lock even when the callback fails).
 */
export const runAssetDialogCallback = async (
  action: () => void | Promise<void>,
  finalize: () => void,
): Promise<AssetDialogCallbackResult> => {
  try {
    await action();

    return {ok: true};
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      error,
    };
  } finally {
    finalize();
  }
};
