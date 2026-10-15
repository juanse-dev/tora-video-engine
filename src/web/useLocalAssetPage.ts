import {useCallback, useContext, useEffect, useRef, useState} from "react";
import type {
  LocalAssetCategory,
  LocalAssetRef,
} from "../localAssets/refs.ts";
import {AssetLibraryContext} from "./assetLibraryContext.ts";
import {
  createLocalAssetPageController,
  EMPTY_LOCAL_ASSET_PAGE,
  type LocalAssetPageController,
  type LocalAssetPageEntry,
  type LocalAssetPageSnapshot,
  type PinnedLocalAsset,
} from "./localAssetPageController.ts";

export type {LocalAssetPageEntry, PinnedLocalAsset};

/**
 * Paging state for one My assets category (see localAssetPageController.ts for
 * the rules). Reads the library and refreshToken from AssetLibraryContext.
 * `pinnedRef` is the scene's current ref; it is loaded even when it is not on
 * the visible page.
 */
export const useLocalAssetPage = (
  category: LocalAssetCategory,
  pinnedRef: LocalAssetRef | null = null,
): LocalAssetPageSnapshot & {next(): void; previous(): void} => {
  const context = useContext(AssetLibraryContext);
  const store = context?.status.kind === "ready" ? context.status.store : null;
  const refreshToken = context?.refreshToken ?? 0;
  const [snapshot, setSnapshot] = useState<LocalAssetPageSnapshot>(
    EMPTY_LOCAL_ASSET_PAGE,
  );
  const controllerRef = useRef<LocalAssetPageController | null>(null);

  useEffect(() => {
    if (store === null) {
      setSnapshot(EMPTY_LOCAL_ASSET_PAGE);

      return;
    }

    const controller = createLocalAssetPageController({store, category});
    const unsubscribe = controller.subscribe(setSnapshot);

    controllerRef.current = controller;

    return () => {
      unsubscribe();

      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }

      // Revokes every thumbnail object URL.
      controller.dispose();
    };
  }, [store, category]);

  // Declared after the effect above so the controller exists. Runs on mount,
  // when another tab or this one changes the library, and when the pin moves.
  useEffect(() => {
    void controllerRef.current?.sync(pinnedRef);
  }, [store, category, refreshToken, pinnedRef]);

  const next = useCallback(() => {
    void controllerRef.current?.next();
  }, []);
  const previous = useCallback(() => {
    void controllerRef.current?.previous();
  }, []);

  return {...snapshot, next, previous};
};
