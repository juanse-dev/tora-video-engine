import {useEffect, useMemo, useState} from "react";
import type {AudioDurationMap} from "../audio/catalog.ts";
import {storyAudioDurations, storyAudioRefs} from "../audio/storyAudio.ts";
import {isLocalAudioRef, type LocalAudioRef} from "../localAssets/refs.ts";
import type {Story} from "../story/types.ts";
import type {AssetLibraryStatus} from "./assetLibrary/coordination.ts";
import {readAudioDurations} from "./assetLibrary/library.ts";

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

  useEffect(() => {
    const refs = parseLocalAudioRefsKey(refsKey);
    let cancelled = false;
    const settle = (next: AudioDurationMap) => {
      if (!cancelled) {
        setLocal((current) => (sameDurationMap(current, next) ? current : next));
      }
    };

    if (store === null || refs.length === 0) {
      settle(NO_DURATIONS);

      return;
    }

    void readAudioDurations(store, refs).then(settle, () =>
      settle(NO_DURATIONS),
    );

    return () => {
      cancelled = true;
    };
  }, [store, refsKey, refreshToken]);

  return useMemo(() => storyAudioDurations(story, local), [story, local]);
};
