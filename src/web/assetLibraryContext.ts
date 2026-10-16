import {createContext} from "react";
import type {
  LocalAssetCategory,
  LocalAssetRef,
} from "../localAssets/refs.ts";
import type {
  AssetLibraryMessage,
  AssetLibraryStatus,
} from "./assetLibrary/coordination.ts";
import type {AcquirePreviewUrl} from "./audio/previewPlayback.ts";
import type {MutationCancelable} from "./localAssetManageFlow.ts";
import type {StoryLocalAssetState} from "./localAssetState.ts";

/**
 * Dialog callback contract (enforced by AssetDialogHost, rendered by App):
 * - Callbacks should show their own errors, but a throw or rejection is still
 *   caught: it is logged with console.error and, for `onConfirm`/`onReplace`,
 *   shown as a role="alert" line while the dialog stays open.
 * - A mismatch dialog is the end of an import: App clears `assetImportInFlight`
 *   after `onReplace` settles and after `onCancel` runs, even if they throw.
 *   Callbacks do not need to clear it.
 * - `onConfirm` gets `onCancelable`: it calls it with a function while the
 *   delete waits for the exclusive library lock (the host then keeps Cancel
 *   enabled and calls that function) and with `null` once the lock is granted
 *   or the delete ends. A cancelled delete resolves like any other, so the
 *   dialog closes; the callback shows its own "Delete cancelled." notice.
 * - The dialog closes after `onConfirm`/`onReplace` succeed and after
 *   `onCancel` (even if it throws), and only if it is still the open dialog.
 */
export type AssetDialog =
  | {
      kind: "delete";
      ref: LocalAssetRef;
      label: string;
      category: LocalAssetCategory;
      sceneCount: number;
      /** Audio only: the Story's music uses the ref. */
      usesMusic?: boolean;
      /** Audio only: 1-based numbers of the scenes using the ref. */
      sceneNumbers?: readonly number[];
      onConfirm: (onCancelable: MutationCancelable) => Promise<void>;
    }
  | {
      kind: "mismatch";
      candidateRef: LocalAssetRef;
      onReplace: () => Promise<void>;
      onCancel: () => void;
    };

/** Stand-in status while openAssetLibrary has not settled yet. */
export const OPENING_ASSET_LIBRARY = {
  kind: "unavailable",
  message: "Checking local assets…",
} as const satisfies AssetLibraryStatus;

export type AssetLibraryContextValue = {
  status: AssetLibraryStatus; // ASSET-002
  locks: LockManager | undefined;
  /** Posts to other tabs and also invalidates/refreshes locally (BroadcastChannel never echoes to the sender). */
  channel: {post(m: AssetLibraryMessage): void};
  refreshToken: number; // ASSET-004; bump to refetch pages
  bumpRefresh: () => void;
  localAssetState: StoryLocalAssetState; // ASSET-004; per-ref readiness
  setAssetImportInFlight: (inFlight: boolean) => void; // locks authoring during imports
  /**
   * Offers (a function) or withdraws (null) Cancel for an import whose commit
   * is waiting for the exclusive library lock. App renders it outside the
   * authoring fieldset, which is disabled for the whole import.
   */
  setAssetImportCancel: (cancel: (() => void) | null) => void;
  transitionPending: boolean; // App transition panel open -> imports disabled
  /** Rendered by App outside the fieldset. Returns false (nothing opened) while an App transition panel or another asset dialog is open. */
  openAssetDialog: (dialog: AssetDialog) => boolean;
  /**
   * Closes whatever asset dialog is open without running its callbacks. Safe
   * for a mismatch dialog too: App releases the import lock it holds. Prefer
   * the dialog's own Cancel (which also runs `onCancel`).
   */
  closeAssetDialog: () => void;
  /** A verified object URL for a library sound, for the My audio preview (same pool as images). */
  acquirePreviewUrl: AcquirePreviewUrl;
};

export const AssetLibraryContext =
  createContext<AssetLibraryContextValue | null>(null);
