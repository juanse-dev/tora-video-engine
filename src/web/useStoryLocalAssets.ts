import {useEffect, useMemo, useState} from "react";
import {collectStoryLocalAssetUsages} from "../localAssets/readiness.ts";
import type {LocalAssetSourceMap} from "../localAssets/sources.ts";
import type {Story} from "../story/schema.ts";
import type {AssetLibraryStatus} from "./assetLibrary/coordination.ts";
import type {IntegrityCache} from "./assetLibrary/integrity.ts";
import type {StoryLocalAssetState} from "./localAssetState.ts";
import type {ObjectUrlPool} from "./objectUrlPool.ts";
import {
  createStoryLocalAssetsController,
  selectVisibleLocalAssets,
  type SettledLocalAssets,
} from "./storyLocalAssetsController.ts";

/**
 * Thin React wrapper around `createStoryLocalAssetsController`.
 *
 * `library` must be referentially stable (App keeps it in `useState`); the
 * effect restarts whenever `story`, `library` or `refreshToken` changes.
 * `null` means the library is still opening: no generation runs and local refs
 * stay `pending` (never a spurious `unavailable`).
 */
export const useStoryLocalAssets = (
  story: Story,
  library: AssetLibraryStatus | null,
  cache: IntegrityCache,
  pool: ObjectUrlPool,
  refreshToken: number,
): {state: StoryLocalAssetState; sources: LocalAssetSourceMap | undefined} => {
  const controller = useMemo(
    () => createStoryLocalAssetsController({pool, cache}),
    [pool, cache],
  );
  const [settled, setSettled] = useState<SettledLocalAssets | null>(null);

  useEffect(() => {
    if (library === null) {
      return;
    }

    return controller.start(story, library, (snapshot) =>
      setSettled({snapshot, story, library, refreshToken}),
    );
  }, [controller, story, library, refreshToken]);

  // Declared after the start effect, so it commits only once the snapshot has
  // rendered; the controller then releases every older lease and the Player
  // never holds a revoked URL.
  useEffect(() => {
    if (settled !== null) {
      controller.commit(settled.snapshot);
    }
  }, [controller, settled]);

  // Unmount (or a new controller): abort the generation in flight and release
  // every outstanding lease, including snapshots that never reached a commit.
  useEffect(() => () => controller.dispose(), [controller]);

  const usages = useMemo(() => collectStoryLocalAssetUsages(story), [story]);

  return useMemo(
    () =>
      selectVisibleLocalAssets({story, library, refreshToken, usages, settled}),
    [story, library, refreshToken, usages, settled],
  );
};
