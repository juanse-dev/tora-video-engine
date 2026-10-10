import {
  parseLocalAssetRef,
  type LocalAssetCategory,
  type LocalAssetRef,
} from "../localAssets/refs.ts";
import {shortAssetId} from "../localAssets/sources.ts";
import type {Story} from "../story/types.ts";

/**
 * 1-based numbers of the scenes in the Active Story whose pose or background
 * equals ref. A ref carries its category, so the other category's ref with
 * the same digest never matches.
 */
export const sceneNumbersUsingRef = (
  story: Story,
  ref: LocalAssetRef,
): number[] =>
  story.scenes.flatMap((scene, index) =>
    scene.pose === ref || scene.background === ref ? [index + 1] : [],
  );

/** Number of scenes (not fields) in the Active Story that use ref. */
export const countScenesUsingRef = (story: Story, ref: LocalAssetRef): number =>
  sceneNumbersUsingRef(story, ref).length;

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
  ref: LocalAssetRef;
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

export const mismatchDialogText = (candidateRef: LocalAssetRef): string =>
  `This file is a different image (${shortAssetId(candidateRef)}), so it can't restore the missing one.`;
