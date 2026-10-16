import {useEffect, useMemo, useState} from "react";
import type {AudioRef, BundledAudio} from "../../audio/catalog.ts";
import {parseLocalAssetRef, type LocalAudioRef} from "../../localAssets/refs.ts";
import type {Story} from "../../story/types.ts";
import type {AssetLibraryStatus} from "../assetLibrary/coordination.ts";
import {readWaveform} from "../assetLibrary/library.ts";
import type {AssetLibraryStore} from "../assetLibrary/store.ts";
import {localAudioRefsKey, parseLocalAudioRefsKey} from "../useStoryAudioDurations.ts";
import type {BundledAudioState} from "./bundledAudio.ts";
import type {WaveformPeaks} from "./waveformColumns.ts";

/** The peaks of every sound of the Story that has some, by ref. */
export type StoryWaveforms = ReadonlyMap<AudioRef, WaveformPeaks>;

const NO_WAVEFORMS: StoryWaveforms = new Map();

/**
 * The stored peaks (`readWaveform(store, digest)`, AUDIO-003) of exactly these
 * local refs. A ref with no stored or readable waveform is simply left out.
 */
export const readStoryWaveforms = async (
  store: Pick<AssetLibraryStore, "getWaveform">,
  refs: Iterable<LocalAudioRef>,
): Promise<Map<LocalAudioRef, WaveformPeaks>> => {
  const waveforms = new Map<LocalAudioRef, WaveformPeaks>();

  for (const ref of new Set(refs)) {
    const parsed = parseLocalAssetRef(ref);
    const record =
      parsed === null ? null : await readWaveform(store, parsed.digest);

    if (record !== null) {
      waveforms.set(ref, record);
    }
  }

  return waveforms;
};

/**
 * One read for the effect of `useStoryWaveforms`; the same contract as
 * `startAudioDurationRead`: `settle` runs once unless the returned cancel ran
 * first, and a failed read or no library settles the empty map.
 */
export const startWaveformRead = (
  store: Pick<AssetLibraryStore, "getWaveform"> | null,
  refs: readonly LocalAudioRef[],
  settle: (waveforms: StoryWaveforms) => void,
): (() => void) => {
  let cancelled = false;
  const deliver = (next: StoryWaveforms) => {
    if (!cancelled) {
      settle(next);
    }
  };

  if (store === null || refs.length === 0) {
    deliver(NO_WAVEFORMS);
  } else {
    void readStoryWaveforms(store, refs).then(deliver, () =>
      deliver(NO_WAVEFORMS),
    );
  }

  return () => {
    cancelled = true;
  };
};

const samePeaks = (a: WaveformPeaks, b: WaveformPeaks): boolean =>
  a.peaksPerSecond === b.peaksPerSecond &&
  a.peaks.length === b.peaks.length &&
  a.peaks.every((value, index) => value === b.peaks[index]);

/** Entry-wise equality by content, so an unchanged library keeps the previous map (and the canvases are not redrawn). */
export const sameWaveforms = (a: StoryWaveforms, b: StoryWaveforms): boolean =>
  a.size === b.size &&
  [...a].every(([ref, peaks]) => {
    const other = b.get(ref);

    return other !== undefined && samePeaks(peaks, other);
  });

/** The local peaks plus the peaks of every bundled id the store has checked (`ready`). */
export const mergeWaveforms = (
  local: StoryWaveforms,
  bundled: ReadonlyMap<BundledAudio, BundledAudioState>,
): StoryWaveforms => {
  const merged = new Map<AudioRef, WaveformPeaks>(local);

  for (const [id, state] of bundled) {
    if (state.kind === "ready") {
      merged.set(id, state.peaks);
    }
  }

  return merged;
};

/**
 * The waveforms the timeline draws: local peaks read from the library for the
 * Story's own local refs (again when the library changes), bundled peaks from
 * the bundled-audio store.
 */
export const useStoryWaveforms = (
  story: Story,
  library: AssetLibraryStatus | null,
  refreshToken: number,
  bundled: ReadonlyMap<BundledAudio, BundledAudioState>,
): StoryWaveforms => {
  const refsKey = localAudioRefsKey(story);
  const store = library?.kind === "ready" ? library.store : null;
  const [local, setLocal] = useState<StoryWaveforms>(NO_WAVEFORMS);

  useEffect(
    () =>
      startWaveformRead(store, parseLocalAudioRefsKey(refsKey), (next) =>
        setLocal((current) => (sameWaveforms(current, next) ? current : next)),
      ),
    [store, refsKey, refreshToken],
  );

  return useMemo(() => mergeWaveforms(local, bundled), [local, bundled]);
};
