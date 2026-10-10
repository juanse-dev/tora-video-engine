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
  openAssetDialog: (dialog: AssetDialog) => void; // rendered by App outside the fieldset
  closeAssetDialog: () => void;
};

export const AssetLibraryContext =
  createContext<AssetLibraryContextValue | null>(null);
