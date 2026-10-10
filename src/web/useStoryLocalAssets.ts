import {useEffect, useMemo, useState} from "react";
import {collectStoryLocalAssetUsages} from "../localAssets/readiness.ts";
import type {LocalAssetSourceMap} from "../localAssets/sources.ts";
import type {Story} from "../story/schema.ts";
import type {AssetLibraryStatus} from "./assetLibrary/coordination.ts";
import type {IntegrityCache} from "./assetLibrary/integrity.ts";
import type {StoryLocalAssetState} from "./localAssetState.ts";
import type {ObjectUrlPool} from "./objectUrlPool.ts";
import {
  buildPendingSources,
  createStoryLocalAssetsController,
  type StoryLocalAssetsSnapshot,
} from "./storyLocalAssetsController.ts";

type SettledResult = {
  snapshot: StoryLocalAssetsSnapshot;
  story: Story;
  library: AssetLibraryStatus;
  refreshToken: number;
};

/**
 * Thin React wrapper around `createStoryLocalAssetsController`.
 *
 * `library` must be referentially stable (App keeps it in `useState`); the
 * effect restarts whenever `story`, `library` or `refreshToken` changes.
 */
export const useStoryLocalAssets = (
  story: Story,
  library: AssetLibraryStatus,
  cache: IntegrityCache,
  pool: ObjectUrlPool,
  refreshToken: number,
): {state: StoryLocalAssetState; sources: LocalAssetSourceMap | undefined} => {
  const controller = useMemo(
    () => createStoryLocalAssetsController({pool, cache}),
    [pool, cache],
  );
  const [settled, setSettled] = useState<SettledResult | null>(null);

  useEffect(
    () =>
      controller.start(story, library, (snapshot) =>
        setSettled({snapshot, story, library, refreshToken}),
      ),
    [controller, story, library, refreshToken],
  );

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
  const current =
    settled !== null &&
    settled.story === story &&
    settled.library === library &&
    settled.refreshToken === refreshToken
      ? settled
      : null;

  return useMemo(() => {
    if (current !== null) {
      return {
        state: current.snapshot.state,
        sources: current.snapshot.sources,
      };
    }

    if (usages.length === 0) {
      return {state: {kind: "none"} as const, sources: undefined};
    }

    return {
      state: {kind: "pending", usages} as const,
      sources: buildPendingSources(usages, settled?.snapshot.sources),
    };
  }, [current, settled, usages]);
};
