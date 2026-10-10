import type {LocalAssetRef} from "../localAssets/refs.ts";
import type {AssetLibraryContextValue} from "./assetLibraryContext.ts";
import {
  deleteLocalAsset,
  normalizeLocalAssetLabel,
  renameLocalAsset,
  type AssetLibrary,
} from "./assetLibrary/library.ts";

export const RENAME_NOT_FOUND_MESSAGE = "This asset was deleted in another tab.";
export const RENAME_FAILED_MESSAGE = "The asset could not be renamed.";
export const DELETE_FAILED_MESSAGE = "The asset could not be deleted.";

/**
 * The handle the mutations need, or null while My assets is not ready (the
 * library is disabled/unavailable/opening) or Web Locks are missing.
 */
export const libraryFromContext = (
  context: Pick<AssetLibraryContextValue, "status" | "locks" | "channel">,
): AssetLibrary | null =>
  context.status.kind === "ready" && context.locks !== undefined
    ? {
        store: context.status.store,
        locks: context.locks,
        channel: context.channel,
      }
    : null;

export type RenameOutcome =
  | {kind: "renamed"; label: string}
  | {kind: "invalid"; message: string}
  | {kind: "not-found"; message: string}
  | {kind: "failed"; message: string; error: unknown};

/**
 * Validates the label (nothing is written when it is invalid) and renames
 * through the library, which announces the change. Never throws.
 */
export const renameAssetFlow = async (
  library: AssetLibrary,
  ref: LocalAssetRef,
  label: string,
): Promise<RenameOutcome> => {
  const normalized = normalizeLocalAssetLabel(label);

  if (!normalized.ok) {
    return {kind: "invalid", message: normalized.message};
  }

  try {
    const result = await renameLocalAsset(library, ref, normalized.label);

    return result.kind === "not-found"
      ? {kind: "not-found", message: RENAME_NOT_FOUND_MESSAGE}
      : {kind: "renamed", label: normalized.label};
  } catch (error) {
    return {kind: "failed", message: RENAME_FAILED_MESSAGE, error};
  }
};

/**
 * Deletes the asset (the Story is never touched). An asset that is already
 * gone counts as deleted ("not-found": the library announced nothing, so the
 * caller refreshes). Rejects with a friendly Error on a failure, which the
 * dialog host shows and logs.
 */
export const deleteAssetFlow = async (
  library: AssetLibrary,
  ref: LocalAssetRef,
): Promise<"deleted" | "not-found"> => {
  try {
    const result = await deleteLocalAsset(library, ref);

    return result.kind === "not-found" ? "not-found" : "deleted";
  } catch (error) {
    const failure = new Error(DELETE_FAILED_MESSAGE);

    (failure as {cause?: unknown}).cause = error;
    throw failure;
  }
};
