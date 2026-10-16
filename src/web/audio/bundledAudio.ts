import {useSyncExternalStore} from "react";
import {staticFile} from "remotion";
import {
  bundledAudioCatalog,
  isBundledAudio,
  type BundledAudio,
  type BundledAudioEntry,
} from "../../audio/catalog.ts";
import {isDecodeComplete} from "../../audio/decodeCheck.ts";
import {storyAudioRefs} from "../../audio/storyAudio.ts";
import type {AudioSource} from "../../audio/sources.ts";
import {
  inspectAudio,
  type AudioInspection,
  type AudioMetadata,
} from "../../localAssets/audioInspection.ts";
import type {Story} from "../../story/types.ts";
import {
  AUDIO_DECODE_FAILED_MESSAGE,
  decodeAudioPeaks,
  type DecodedAudioSummary,
} from "../assetLibrary/audioPeaks.ts";
import {AUDIO_TRUNCATED_MESSAGE} from "../assetLibrary/importAudio.ts";
import type {WaveformPeaks} from "./waveformColumns.ts";

/** After the first failed fetch the store retries after 1 s, 2 s and 4 s, then gives up until `Retry`. */
export const BUNDLED_AUDIO_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

/** The text of a field whose bundled sound could not be fetched (a `Retry` button follows). */
export const BUNDLED_AUDIO_FETCH_FAILED_MESSAGE = "Audio could not be loaded.";

/** A catalog entry without a file (the owner has not supplied the music yet). */
export const BUNDLED_AUDIO_NOT_SUPPLIED_MESSAGE =
  "This bundled sound has no file in this build.";

export type BundledAudioState =
  | {kind: "loading"}
  | {kind: "retrying"; attempt: 1 | 2 | 3}
  /** `url` is ONE object URL of `blob`, created once for the page session. */
  | {kind: "ready"; peaks: WaveformPeaks; blob: Blob; url: string}
  | {kind: "fetch-failed"; message: string}
  | {kind: "unusable"; message: string};

/** The few members of a fetch Response the store uses. */
export type BundledAudioResponse = {
  ok: boolean;
  blob: () => Promise<Blob>;
};

export type BundledAudioDeps = {
  fetch: (
    url: string,
    init: {signal: AbortSignal},
  ) => Promise<BundledAudioResponse>;
  inspect: (blob: Blob) => Promise<AudioInspection>;
  decode: (
    blob: Blob,
    metadata: AudioMetadata,
    signal: AbortSignal,
  ) => Promise<DecodedAudioSummary>;
  /** `staticFile(entry.file)` in the browser. */
  fileUrl: (file: string) => string;
  createObjectUrl: (blob: Blob) => string;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  catalog: Readonly<Record<BundledAudio, BundledAudioEntry>>;
  retryDelaysMs: readonly number[];
};

type Outcome =
  | {kind: "ready"; peaks: WaveformPeaks; blob: Blob}
  | {kind: "transient"}
  | {kind: "terminal"; message: string};

type Run = {controller: AbortController; timer: unknown};

const NO_STATES: ReadonlyMap<BundledAudio, BundledAudioState> = new Map();

/**
 * The page-session store of bundled sounds: the ONE source of truth for their
 * peaks, their playability and (AUDIO-005) their render readiness. It is built
 * from injected dependencies so Node tests drive every transition; the page
 * uses the module-level functions below.
 *
 * Each id is checked once per page session: fetch the file, `inspectAudio`,
 * decode the peaks (`decodeAudioPeaks`) and apply the D-9 truncation rule. A
 * network failure is transient (retries after 1 s, 2 s and 4 s, then
 * `fetch-failed` until `retry`); an inspection or decode failure, or a
 * truncated file, is terminal (`unusable`, memoized, never fetched again,
 * because the files are fixed per build). `ready` is memoized too. Ids that
 * stop being requested lose their in-flight fetch, pending retry and any
 * non-terminal state, so a later request starts them afresh.
 *
 * `getStates()` returns a NEW map on every transition and the same object
 * otherwise (it feeds `useSyncExternalStore`).
 */
export const createBundledAudioStore = (deps: BundledAudioDeps) => {
  let states: ReadonlyMap<BundledAudio, BundledAudioState> = NO_STATES;
  let requested: ReadonlySet<BundledAudio> = new Set();
  const runs = new Map<BundledAudio, Run>();
  const listeners = new Set<() => void>();

  const publish = (next: ReadonlyMap<BundledAudio, BundledAudioState>) => {
    states = next;

    for (const listener of [...listeners]) {
      listener();
    }
  };

  const setState = (id: BundledAudio, state: BundledAudioState) => {
    publish(new Map(states).set(id, state));
  };

  const dropState = (id: BundledAudio) => {
    const next = new Map(states);

    next.delete(id);
    publish(next);
  };

  const check = async (
    file: string,
    signal: AbortSignal,
  ): Promise<Outcome> => {
    let blob: Blob;

    try {
      const response = await deps.fetch(deps.fileUrl(file), {signal});

      if (!response.ok) {
        return {kind: "transient"};
      }

      blob = await response.blob();
    } catch {
      return {kind: "transient"};
    }

    if (signal.aborted) {
      return {kind: "transient"};
    }

    try {
      const inspected = await deps.inspect(blob);

      if (!inspected.ok) {
        return {kind: "terminal", message: inspected.message};
      }

      const summary = await deps.decode(blob, inspected.metadata, signal);

      return isDecodeComplete(summary.decodedSeconds, inspected.metadata.durationSeconds)
        ? {
            kind: "ready",
            blob,
            peaks: {peaksPerSecond: summary.peaksPerSecond, peaks: summary.peaks},
          }
        : {kind: "terminal", message: AUDIO_TRUNCATED_MESSAGE};
    } catch {
      return {kind: "terminal", message: AUDIO_DECODE_FAILED_MESSAGE};
    }
  };

  const attempt = async (
    id: BundledAudio,
    file: string,
    run: Run,
    retriesDone: number,
  ) => {
    const outcome = await check(file, run.controller.signal);

    // Stopped being requested while the check ran: nothing to publish.
    if (run.controller.signal.aborted) {
      return;
    }

    if (outcome.kind === "ready") {
      runs.delete(id);
      setState(id, {
        kind: "ready",
        peaks: outcome.peaks,
        blob: outcome.blob,
        url: deps.createObjectUrl(outcome.blob),
      });

      return;
    }

    if (outcome.kind === "terminal") {
      runs.delete(id);
      setState(id, {kind: "unusable", message: outcome.message});

      return;
    }

    if (retriesDone >= deps.retryDelaysMs.length) {
      runs.delete(id);
      setState(id, {
        kind: "fetch-failed",
        message: BUNDLED_AUDIO_FETCH_FAILED_MESSAGE,
      });

      return;
    }

    setState(id, {kind: "retrying", attempt: (retriesDone + 1) as 1 | 2 | 3});
    run.timer = deps.setTimer(() => {
      run.timer = null;
      void attempt(id, file, run, retriesDone + 1);
    }, deps.retryDelaysMs[retriesDone]);
  };

  const start = (id: BundledAudio) => {
    const {file} = deps.catalog[id];

    // No file in this build (the music is not supplied yet): nothing to fetch.
    if (file === null) {
      setState(id, {kind: "unusable", message: BUNDLED_AUDIO_NOT_SUPPLIED_MESSAGE});

      return;
    }

    const run: Run = {controller: new AbortController(), timer: null};

    runs.set(id, run);
    setState(id, {kind: "loading"});
    void attempt(id, file, run, 0);
  };

  const cancel = (id: BundledAudio) => {
    const run = runs.get(id);

    if (run !== undefined) {
      run.controller.abort();

      if (run.timer !== null) {
        deps.clearTimer(run.timer);
      }

      runs.delete(id);
    }

    const state = states.get(id);

    // ready and unusable are memoized for the page session.
    if (state !== undefined && state.kind !== "ready" && state.kind !== "unusable") {
      dropState(id);
    }
  };

  return {
    /**
     * Starts the check of every id not started yet and cancels the ones that
     * are no longer requested. The argument is the whole set that is wanted now.
     */
    request: (ids: Iterable<BundledAudio>) => {
      const wanted = new Set(ids);

      for (const id of requested) {
        if (!wanted.has(id)) {
          cancel(id);
        }
      }

      requested = wanted;

      for (const id of wanted) {
        if (!states.has(id)) {
          start(id);
        }
      }
    },
    /** `fetch-failed` back to `loading` with a fresh retry schedule; any other state is left alone. */
    retry: (id: BundledAudio) => {
      if (states.get(id)?.kind === "fetch-failed" && requested.has(id)) {
        start(id);
      }
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    getStates: (): ReadonlyMap<BundledAudio, BundledAudioState> => states,
  };
};

export type BundledAudioStore = ReturnType<typeof createBundledAudioStore>;

let pageStore: BundledAudioStore | null = null;

const store = (): BundledAudioStore => {
  pageStore ??= createBundledAudioStore({
    fetch: (url, init) => fetch(url, init),
    inspect: (blob) => inspectAudio(blob),
    decode: (blob, metadata, signal) => decodeAudioPeaks(blob, metadata, {signal}),
    fileUrl: (file) => staticFile(file),
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    catalog: bundledAudioCatalog,
    retryDelaysMs: BUNDLED_AUDIO_RETRY_DELAYS_MS,
  });

  return pageStore;
};

export const requestBundledAudio = (ids: Iterable<BundledAudio>): void =>
  store().request(ids);

export const retryBundledAudio = (id: BundledAudio): void => store().retry(id);

export const subscribeBundledAudio = (listener: () => void): (() => void) =>
  store().subscribe(listener);

export const getBundledAudioStates = (): ReadonlyMap<BundledAudio, BundledAudioState> =>
  store().getStates();

export const useBundledAudioStates = (): ReadonlyMap<BundledAudio, BundledAudioState> =>
  useSyncExternalStore(
    subscribeBundledAudio,
    getBundledAudioStates,
    getBundledAudioStates,
  );

/** The bundled ids a Story references, in `storyAudioRefs` order. */
export const storyBundledAudio = (story: Story): BundledAudio[] =>
  storyAudioRefs(story).filter(isBundledAudio);

/** The Story's distinct bundled ids, sorted and comma-joined: the effect key that says "the requested set changed" (`""` when none). */
export const bundledAudioKey = (story: Story): string =>
  [...new Set(storyBundledAudio(story))].sort().join(",");

export const parseBundledAudioKey = (key: string): BundledAudio[] =>
  key === "" ? [] : (key.split(",") as BundledAudio[]);

/**
 * What the Player's source map holds for a bundled id: `pending` while the
 * check runs, retries or waits for `Retry`; the object URL of the checked Blob
 * when ready; `unavailable` for a terminal failure. An id without a state is
 * left out (under the `"explicit"` policy that resolves to `pending`).
 */
export const audioSourceForBundledState = (
  state: BundledAudioState | undefined,
): AudioSource | undefined => {
  if (state === undefined) {
    return undefined;
  }

  switch (state.kind) {
    case "ready":
      return {kind: "url", url: state.url};
    case "unusable":
      return {kind: "unavailable"};
    default:
      return {kind: "pending"};
  }
};
