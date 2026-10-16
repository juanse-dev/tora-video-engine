import {useEffect, useMemo, useState} from "react";
import type {AudioDurationMap} from "../audio/catalog.ts";
import {storyAudioDurations, storyAudioRefs} from "../audio/storyAudio.ts";
import {isLocalAudioRef, type LocalAudioRef} from "../localAssets/refs.ts";
import type {Story} from "../story/types.ts";
import type {AssetLibraryStatus} from "./assetLibrary/coordination.ts";
import {readAudioDurations} from "./assetLibrary/library.ts";
import type {AssetLibraryStore} from "./assetLibrary/store.ts";

const NO_DURATIONS: AudioDurationMap = Object.freeze({});

/** The Story's distinct local audio refs, sorted, comma-joined: the effect key (`""` when none). */
export const localAudioRefsKey = (story: Story): string =>
  storyAudioRefs(story).filter(isLocalAudioRef).sort().join(",");

export const parseLocalAudioRefsKey = (key: string): LocalAudioRef[] =>
  key === "" ? [] : (key.split(",") as LocalAudioRef[]);

/** Entry-wise equality, so an unchanged library keeps the previous object (and every memo built on it). */
export const sameDurationMap = (
  a: AudioDurationMap,
  b: AudioDurationMap,
): boolean => {
  const first = Object.entries(a);

  return (
    first.length === Object.keys(b).length &&
    first.every(([ref, seconds]) => (b as Record<string, number | undefined>)[ref] === seconds)
  );
};

/**
 * One read of the Story's local durations, for the effect of
 * `useStoryAudioDurations`. `settle` gets the map exactly once, unless the
 * returned cancel function ran first (the effect's cleanup: the Story's refs,
 * the library or the refresh token changed), in which case a result that
 * arrives late is discarded. No library, no local refs or a failed read give
 * the empty map (the refs stay missing and the bundled durations still apply).
 */
export const startAudioDurationRead = (
  store: Pick<AssetLibraryStore, "getAssetRow" | "getPayloadMeta"> | null,
  refs: readonly LocalAudioRef[],
  settle: (durations: AudioDurationMap) => void,
): (() => void) => {
  let cancelled = false;
  const deliver = (next: AudioDurationMap) => {
    if (!cancelled) {
      settle(next);
    }
  };

  if (store === null || refs.length === 0) {
    deliver(NO_DURATIONS);
  } else {
    void readAudioDurations(store, refs).then(deliver, () =>
      deliver(NO_DURATIONS),
    );
  }

  return () => {
    cancelled = true;
  };
};

/**
 * The page's ONE audio duration map: bundled durations from the catalog plus the
 * durations of the Story's own local audio refs, read from the library (never
 * from the visible library page). Recomputed when the Story's set of local audio
 * refs changes or `refreshToken` bumps (a library mutation in this or another
 * tab, or window focus). Refs that are absent from the library stay out of the
 * map and keep resolving as missing.
 */
export const useStoryAudioDurations = (
  story: Story,
  library: AssetLibraryStatus | null,
  refreshToken: number,
): AudioDurationMap => {
  const refsKey = localAudioRefsKey(story);
  const store = library?.kind === "ready" ? library.store : null;
  const [local, setLocal] = useState<AudioDurationMap>(NO_DURATIONS);

  useEffect(
    () =>
      startAudioDurationRead(store, parseLocalAudioRefsKey(refsKey), (next) =>
        setLocal((current) => (sameDurationMap(current, next) ? current : next)),
      ),
    [store, refsKey, refreshToken],
  );

  return useMemo(() => storyAudioDurations(story, local), [story, local]);
};
