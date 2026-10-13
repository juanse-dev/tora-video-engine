import {
  parseLocalAssetRef,
  type ImageAssetCategory,
  type LocalImageRef,
} from "../localAssets/refs.ts";
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
  ref: LocalImageRef,
): number[] =>
  story.scenes.flatMap((scene, index) =>
    scene.pose === ref || scene.background === ref ? [index + 1] : [],
  );

/** Number of scenes (not fields) that use ref; see sceneNumbersUsingRef for which scenes to pass. */
export const countScenesUsingRef = (
  story: {readonly scenes: readonly SceneAssetValues[]},
  ref: LocalImageRef,
): number => sceneNumbersUsingRef(story, ref).length;

export type MatchingFileResult =
  | {kind: "match"} // same category + same digest
  | {kind: "different"; candidateRef: LocalImageRef};

export const evaluateMatchingFile = (
  missingRef: LocalImageRef,
  candidateRef: LocalImageRef,
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
  category: ImageAssetCategory,
  sceneCount: number,
): string =>
  sceneCount === 0
    ? `Delete "${label}" (${category}) from My assets?`
    : `"${label}" (${category}) is used by ${sceneCount} ${scenesNoun(sceneCount)} in this Story. Deleting it leaves those scenes with a missing local asset, and MP4 rendering stays blocked until you re-import the same file or choose a replacement. Other exported YAML files may also use it.`;

export const deleteConfirmButtonLabel = (sceneCount: number): string =>
  sceneCount === 0 ? "Delete asset" : "Delete asset anyway";

/** "Used by scene 2." / "Used by scenes 1, 3." for 1-based scene numbers. */
export const usedByScenesText = (sceneNumbers: readonly number[]): string =>
  sceneNumbers.length === 0
    ? "Not used by any scene in this Story."
    : `Used by ${scenesNoun(sceneNumbers.length)} ${sceneNumbers.join(", ")}.`;

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
}: {
  ref: LocalImageRef;
  sceneNumbers: readonly number[];
  damaged: boolean;
}): MissingLocalAssetCopy => {
  const parsed = parseLocalAssetRef(ref);

  if (parsed === null) {
    throw new Error(`Not a local asset ref: ${ref}`);
  }

  const {category} = parsed;

  return {
    title: `Missing local ${category}`,
    shortId: shortAssetId(ref),
    usedBy: usedByScenesText(sceneNumbers),
    hint: `Import the original file to restore it, or pick any other ${category} to replace it.`,
    damagedNote: damaged ? "The stored copy is damaged." : null,
  };
};

export const mismatchDialogText = (candidateRef: LocalImageRef): string =>
  `This file is a different image (${shortAssetId(candidateRef)}), so it can't restore the missing one.`;

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
