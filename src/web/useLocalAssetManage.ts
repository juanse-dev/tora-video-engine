import {useCallback, useContext, useRef, useState} from "react";
import type {
  ImageAssetCategory,
  LocalImageRef,
} from "../localAssets/refs.ts";
import {AssetLibraryContext} from "./assetLibraryContext.ts";
import {
  DELETE_CANCELLED_MESSAGE,
  deleteAssetFlow,
  libraryFromContext,
  renameAssetFlow,
  type MutationCancelable,
} from "./localAssetManageFlow.ts";

export type LocalAssetManage = {
  /** A message that outlives the card it is about (for example "deleted in another tab"). */
  notice: string | null;
  /**
   * A neutral line (not an error) after the user cancelled a rename/delete that
   * was waiting for the library lock: "Rename cancelled." / "Delete cancelled.".
   */
  cancelledNotice: string | null;
  /** Clears both `notice` and `cancelledNotice`. */
  clearNotice: () => void;
  /**
   * Resolves to an inline error message for the card, or null when the card is
   * done editing (also after a cancel). `onCancelable` offers Cancel while the
   * rename waits for the library lock (see MutationCancelable).
   */
  rename: (
    ref: LocalImageRef,
    label: string,
    onCancelable?: MutationCancelable,
  ) => Promise<string | null>;
  /**
   * Opens the delete dialog. `sceneCount` is the number of scenes the user is
   * looking at that use the ref (the visual draft, see sceneNumbersUsingRef);
   * it is fixed now because the Story is frozen while the dialog is open.
   */
  requestDelete: (asset: {
    ref: LocalImageRef;
    label: string;
    category: ImageAssetCategory;
    sceneCount: number;
  }) => void;
};

/** Rename and delete for My assets cards, through the context's channel wrapper (R4). */
export const useLocalAssetManage = (): LocalAssetManage => {
  const context = useContext(AssetLibraryContext);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelledNotice, setCancelledNotice] = useState<string | null>(null);
  const contextRef = useRef(context);

  contextRef.current = context;

  const clearNotice = useCallback(() => {
    setNotice(null);
    setCancelledNotice(null);
  }, []);

  const rename = useCallback(
    async (
      ref: LocalImageRef,
      label: string,
      onCancelable?: MutationCancelable,
    ) => {
      const current = contextRef.current;
      const library = current === null ? null : libraryFromContext(current);

      if (current === null || library === null) {
        return "My assets is not available right now.";
      }

      setNotice(null);
      setCancelledNotice(null);

      const outcome = await renameAssetFlow(library, ref, label, {onCancelable});

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
        case "cancelled":
          // A neutral notice, not an error: the user asked for it.
          setCancelledNotice(outcome.message);

          return null;
        case "failed":
          console.error("My assets rename failed:", outcome.error);

          return outcome.message;
      }
    },
    [],
  );

  const requestDelete = useCallback(
    ({
      ref,
      label,
      category,
      sceneCount,
    }: {
      ref: LocalImageRef;
      label: string;
      category: ImageAssetCategory;
      sceneCount: number;
    }) => {
      const current = contextRef.current;
      const library = current === null ? null : libraryFromContext(current);

      if (current === null || library === null) {
        return;
      }

      setNotice(null);
      setCancelledNotice(null);
      current.openAssetDialog({
        kind: "delete",
        ref,
        label,
        category,
        sceneCount,
        onConfirm: async (onCancelable) => {
          const result = await deleteAssetFlow(library, ref, {onCancelable});

          if (result === "not-found") {
            current.bumpRefresh();
          } else if (result === "cancelled") {
            setCancelledNotice(DELETE_CANCELLED_MESSAGE);
          }
        },
      });
    },
    [],
  );

  return {notice, cancelledNotice, clearNotice, rename, requestDelete};
};
