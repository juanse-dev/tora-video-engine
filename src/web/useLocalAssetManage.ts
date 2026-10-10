import {useCallback, useContext, useRef, useState} from "react";
import type {
  LocalAssetCategory,
  LocalAssetRef,
} from "../localAssets/refs.ts";
import {AssetLibraryContext} from "./assetLibraryContext.ts";
import {countScenesUsingRef} from "./localAssetUi.ts";
import {
  deleteAssetFlow,
  libraryFromContext,
  renameAssetFlow,
} from "./localAssetManageFlow.ts";

export type LocalAssetManage = {
  /** A message that outlives the card it is about (for example "deleted in another tab"). */
  notice: string | null;
  clearNotice: () => void;
  /** Resolves to an inline error message for the card, or null when the card is done editing. */
  rename: (ref: LocalAssetRef, label: string) => Promise<string | null>;
  /** Opens the delete dialog; `sceneCount` is computed now (the Story is frozen while it is open). */
  requestDelete: (asset: {
    ref: LocalAssetRef;
    label: string;
    category: LocalAssetCategory;
  }) => void;
};

/** Rename and delete for My assets cards, through the context's channel wrapper (R4). */
export const useLocalAssetManage = (): LocalAssetManage => {
  const context = useContext(AssetLibraryContext);
  const [notice, setNotice] = useState<string | null>(null);
  const contextRef = useRef(context);

  contextRef.current = context;

  const clearNotice = useCallback(() => setNotice(null), []);

  const rename = useCallback(async (ref: LocalAssetRef, label: string) => {
    const current = contextRef.current;
    const library = current === null ? null : libraryFromContext(current);

    if (current === null || library === null) {
      return "My assets is not available right now.";
    }

    setNotice(null);

    const outcome = await renameAssetFlow(library, ref, label);

    switch (outcome.kind) {
      case "renamed":
        return null;
      case "invalid":
        return outcome.message;
      case "not-found":
        // Nothing was written, so nothing was announced: refresh by hand.
        setNotice(outcome.message);
        current.bumpRefresh();

        return null;
      case "failed":
        console.error("My assets rename failed:", outcome.error);

        return outcome.message;
    }
  }, []);

  const requestDelete = useCallback(
    ({
      ref,
      label,
      category,
    }: {
      ref: LocalAssetRef;
      label: string;
      category: LocalAssetCategory;
    }) => {
      const current = contextRef.current;
      const library = current === null ? null : libraryFromContext(current);

      if (current === null || library === null) {
        return;
      }

      setNotice(null);
      current.openAssetDialog({
        kind: "delete",
        ref,
        label,
        category,
        sceneCount: countScenesUsingRef(current.activeStory, ref),
        onConfirm: async () => {
          const result = await deleteAssetFlow(library, ref);

          if (result === "not-found") {
            current.bumpRefresh();
          }
        },
      });
    },
    [],
  );

  return {notice, clearNotice, rename, requestDelete};
};
