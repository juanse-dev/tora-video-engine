import {createContext} from "react";
import type {
  LocalAssetCategory,
  LocalAssetRef,
} from "../localAssets/refs.ts";
import type {Story} from "../story/types.ts";
import type {
  AssetLibraryMessage,
  AssetLibraryStatus,
} from "./assetLibrary/coordination.ts";
import type {StoryLocalAssetState} from "./localAssetState.ts";

/**
 * Dialog callback contract (enforced by AssetDialogHost, rendered by App):
 * - Callbacks should show their own errors, but a throw or rejection is still
 *   caught: it is logged with console.error and, for `onConfirm`/`onReplace`,
 *   shown as a role="alert" line while the dialog stays open.
 * - A mismatch dialog is the end of an import: App clears `assetImportInFlight`
 *   after `onReplace` settles and after `onCancel` runs, even if they throw.
 *   Callbacks do not need to clear it.
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
      onConfirm: () => Promise<void>;
    }
  | {
      kind: "mismatch";
      candidateRef: LocalAssetRef;
      onReplace: () => Promise<void>;
      onCancel: () => void;
    };

export type AssetLibraryContextValue = {
  status: AssetLibraryStatus; // ASSET-002
  locks: LockManager | undefined;
  /** Posts to other tabs and also invalidates/refreshes locally (BroadcastChannel never echoes to the sender). */
  channel: {post(m: AssetLibraryMessage): void};
  refreshToken: number; // ASSET-004; bump to refetch pages
  bumpRefresh: () => void;
  activeStory: Story; // for delete-in-use counts
  localAssetState: StoryLocalAssetState; // ASSET-004; per-ref readiness
  setAssetImportInFlight: (inFlight: boolean) => void; // locks authoring during imports
  transitionPending: boolean; // App transition panel open -> imports disabled
  /** Rendered by App outside the fieldset. Returns false (nothing opened) while an App transition panel or another asset dialog is open. */
  openAssetDialog: (dialog: AssetDialog) => boolean;
  closeAssetDialog: () => void;
};

export const AssetLibraryContext =
  createContext<AssetLibraryContextValue | null>(null);
