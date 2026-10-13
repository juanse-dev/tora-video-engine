import type {LocalImageRef} from "../localAssets/refs.ts";
import type {AssetLibraryContextValue} from "./assetLibraryContext.ts";
import {
  deleteLocalAsset,
  LocalAssetMutationCancelledError,
  normalizeLocalAssetLabel,
  renameLocalAsset,
  type AssetLibrary,
  type LibraryMutationOptions,
} from "./assetLibrary/library.ts";

export const RENAME_NOT_FOUND_MESSAGE = "This asset was deleted in another tab.";
export const RENAME_FAILED_MESSAGE = "The asset could not be renamed.";
export const DELETE_FAILED_MESSAGE = "The asset could not be deleted.";
/** Neutral notices after the user cancelled a rename/delete that was waiting for the library lock. */
export const RENAME_CANCELLED_MESSAGE = "Rename cancelled.";
export const DELETE_CANCELLED_MESSAGE = "Delete cancelled.";

/**
 * Hands the caller a function that cancels the change, or `null` once it can
 * no longer be cancelled. A rename/delete is cancellable only while it waits
 * for the exclusive library lock; the UI shows Cancel exactly while this holds
 * a function.
 */
export type MutationCancelable = (cancel: (() => void) | null) => void;

/**
 * Runs `run` with an abort signal: `onCancelable` gets the cancel function as
 * the change starts waiting for the lock and `null` as soon as the lock is
 * granted or the change ends (exactly once). Without `onCancelable` the change
 * simply cannot be cancelled.
 */
const withLockWaitCancel = async <T>(
  onCancelable: MutationCancelable | undefined,
  run: (options: LibraryMutationOptions) => Promise<T>,
): Promise<T> => {
  if (onCancelable === undefined) {
    return run({});
  }

  const controller = new AbortController();
  let offered = true;
  const withdraw = () => {
    if (offered) {
      offered = false;
      onCancelable(null);
    }
  };

  onCancelable(() => controller.abort());

  try {
    return await run({signal: controller.signal, onLockAcquired: withdraw});
  } finally {
    withdraw();
  }
};

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
  /** The user cancelled while the rename waited for the lock; nothing was written and `message` is a notice, not an error. */
  | {kind: "cancelled"; message: string}
  | {kind: "failed"; message: string; error: unknown};

/**
 * Validates the label (nothing is written when it is invalid) and renames
 * through the library, which announces the change. Never throws.
 * `onCancelable` offers Cancel while the rename waits for the library lock.
 */
export const renameAssetFlow = async (
  library: AssetLibrary,
  ref: LocalImageRef,
  label: string,
  options: {onCancelable?: MutationCancelable} = {},
): Promise<RenameOutcome> => {
  const normalized = normalizeLocalAssetLabel(label);

  if (!normalized.ok) {
    return {kind: "invalid", message: normalized.message};
  }

  try {
    const result = await withLockWaitCancel(options.onCancelable, (mutation) =>
      renameLocalAsset(library, ref, normalized.label, mutation),
    );

    return result.kind === "not-found"
      ? {kind: "not-found", message: RENAME_NOT_FOUND_MESSAGE}
      : {kind: "renamed", label: normalized.label};
  } catch (error) {
    if (error instanceof LocalAssetMutationCancelledError) {
      return {kind: "cancelled", message: RENAME_CANCELLED_MESSAGE};
    }

    return {kind: "failed", message: RENAME_FAILED_MESSAGE, error};
  }
};

/**
 * Deletes the asset (the Story is never touched). An asset that is already
 * gone counts as deleted ("not-found": the library announced nothing, so the
 * caller refreshes). Resolves "cancelled" when the user cancelled while the
 * delete waited for the library lock (nothing was changed). Rejects with a
 * friendly Error on a failure, which the dialog host shows and logs.
 * `onCancelable` offers Cancel while the delete waits for the lock.
 */
export const deleteAssetFlow = async (
  library: AssetLibrary,
  ref: LocalImageRef,
  options: {onCancelable?: MutationCancelable} = {},
): Promise<"deleted" | "not-found" | "cancelled"> => {
  try {
    const result = await withLockWaitCancel(options.onCancelable, (mutation) =>
      deleteLocalAsset(library, ref, mutation),
    );

    return result.kind === "not-found" ? "not-found" : "deleted";
  } catch (error) {
    if (error instanceof LocalAssetMutationCancelledError) {
      return "cancelled";
    }

    const failure = new Error(DELETE_FAILED_MESSAGE);

    (failure as {cause?: unknown}).cause = error;
    throw failure;
  }
};
