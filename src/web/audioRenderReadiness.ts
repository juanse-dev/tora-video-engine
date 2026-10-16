// Render readiness of a Story's audio in the browser, evaluated before the
// Render MP4 click (AUDIO-005). It is a pure function of the Story, the page's
// duration map, the page's local-asset state and the bundled-audio store's
// snapshot, so the button enables by itself when the last pending id becomes
// ready. It never uses the render's own source map: that map only exists
// inside the transaction, after the click.

import {
  isBundledAudio,
  type AudioDurationMap,
  type AudioRef,
  type BundledAudio,
} from "../audio/catalog.ts";
import {compileAudioPlan, type AudioPlan} from "../audio/plan.ts";
import {
  audioFileUnusableMessage,
  storyTooLongWithVoicesMessage,
} from "../audio/readiness.ts";
import {storyAudioRefs, storyHasAudio} from "../audio/storyAudio.ts";
import {isAudioPayload} from "../localAssets/readiness.ts";
import {isLocalAudioRef} from "../localAssets/refs.ts";
import {shortAssetId} from "../localAssets/sources.ts";
import {compileTimeline} from "../story/timeline.ts";
import type {Story} from "../story/types.ts";
import {VIDEO_FPS} from "../videoConfig.ts";
import {MAX_BROWSER_TOTAL_FRAMES} from "./browserPolicy.ts";
import type {StoryLocalAssetState} from "./localAssetState.ts";

export const AUDIO_LOADING_MESSAGE = "Audio is still loading.";
export const AUDIO_FETCH_FAILED_MESSAGE =
  "Audio could not be loaded. Retry it in the editor.";

/**
 * The shape of one entry of the bundled-audio store (`src/web/audio/bundledAudio.ts`,
 * AUDIO-004). Declared here structurally so this module does not depend on the
 * store's code, and so it can run in Node tests.
 */
export type BundledAudioStateLike =
  | {kind: "loading"}
  | {kind: "retrying"; attempt: number}
  | {kind: "ready"}
  | {kind: "fetch-failed"; message: string}
  | {kind: "unusable"; message: string};

export type AudioRefReadiness = "ready" | "pending" | "missing";

const EMPTY_AUDIO_PLAN: AudioPlan = {
  tracks: [],
  issues: [],
  maxSimultaneousGain: 0,
  musicEnvelopeAt: null,
};

export type AudioRenderReadiness = {
  /** Why Render MP4 is blocked by the audio, or null. */
  block: string | null;
  /** The plan compiled with the readiness source states (tracks only for ready sources). */
  plan: AudioPlan;
  /**
   * The durations the plan was compiled with: the page's map plus the durations
   * of the verified local audio, which are the ones the render will use.
   */
  audioDurations: AudioDurationMap;
};

const bundledReadiness = (
  state: BundledAudioStateLike | undefined,
): AudioRefReadiness => {
  switch (state?.kind) {
    case "ready":
      return "ready";
    case "unusable":
      return "missing";
    default:
      // Not requested yet, loading, retrying or waiting for a manual retry.
      return "pending";
  }
};

const localReadiness = (
  ref: AudioRef,
  localState: StoryLocalAssetState,
  audioDurations: AudioDurationMap,
): AudioRefReadiness => {
  if (localState.kind !== "resolved") {
    // Not resolved yet (pending), over budget or no local refs: never ready.
    return "pending";
  }

  const entry = localState.refs.find((candidate) => candidate.usage.ref === ref);

  if (entry === undefined || entry.status !== "ready") {
    return "missing";
  }

  // Verified: its duration is known (a verified payload carries it). A verified
  // ref without any duration is inconsistent data, never "still loading".
  return audioDurations[ref] === undefined ? "missing" : "ready";
};

/**
 * The page's map plus the durations of the Story's verified local audio. A
 * verified payload is exactly what the render will use, and reading it here
 * means a failed read of the page's own duration map can never leave the
 * Story at "Audio is still loading." forever.
 */
const durationsWithVerified = (
  story: Story,
  audioDurations: AudioDurationMap,
  localState: StoryLocalAssetState,
): AudioDurationMap => {
  if (localState.kind !== "resolved") {
    return audioDurations;
  }

  const verifiedDurations: Partial<Record<AudioRef, number>> = {};

  for (const ref of storyAudioRefs(story)) {
    if (!isLocalAudioRef(ref)) {
      continue;
    }

    const verified = localState.verified.get(ref.slice(ref.length - 64));

    if (
      verified !== undefined &&
      isAudioPayload(verified) &&
      Number.isFinite(verified.durationSeconds) &&
      verified.durationSeconds > 0
    ) {
      verifiedDurations[ref] = verified.durationSeconds;
    }
  }

  return {...audioDurations, ...verifiedDurations};
};

type ReadinessInput = {
  story: Story;
  /** The page's one duration map (`useStoryAudioDurations`). */
  audioDurations: AudioDurationMap;
  localState: StoryLocalAssetState;
  bundledStates: ReadonlyMap<BundledAudio, BundledAudioStateLike>;
};

const evaluateWithDurations = (
  input: ReadinessInput,
): Omit<AudioRenderReadiness, "audioDurations"> => {
  const {story, audioDurations, localState, bundledStates} = input;

  // A Story without audio is never blocked by audio and pays nothing for it.
  if (!storyHasAudio(story)) {
    return {block: null, plan: EMPTY_AUDIO_PLAN};
  }

  const timeline = compileTimeline(story, VIDEO_FPS, audioDurations);
  const readinessOf = (ref: AudioRef): AudioRefReadiness =>
    isBundledAudio(ref)
      ? bundledReadiness(bundledStates.get(ref))
      : localReadiness(ref, localState, audioDurations);
  const plan = compileAudioPlan({
    story,
    timeline,
    fps: VIDEO_FPS,
    audioDurations,
    sourceState: readinessOf,
  });

  // Terminal problems first (the person must act), then a failed fetch, then
  // plain loading, and only then the length: a fallback scene would make the
  // exact total meaningless while durations are still unknown.
  let unusable: string | null = null;
  let fetchFailed = false;
  let loading = false;

  for (const ref of storyAudioRefs(story)) {
    const readiness = readinessOf(ref);

    if (readiness === "missing") {
      unusable ??= audioFileUnusableMessage(
        isBundledAudio(ref) ? ref : shortAssetId(ref),
      );
    } else if (readiness === "pending") {
      if (isBundledAudio(ref) && bundledStates.get(ref)?.kind === "fetch-failed") {
        fetchFailed = true;
      } else {
        loading = true;
      }
    }
  }

  if (unusable !== null) {
    return {block: unusable, plan};
  }

  if (fetchFailed) {
    return {block: AUDIO_FETCH_FAILED_MESSAGE, plan};
  }

  if (loading) {
    return {block: AUDIO_LOADING_MESSAGE, plan};
  }

  if (timeline.durationInFrames > MAX_BROWSER_TOTAL_FRAMES) {
    return {
      block: storyTooLongWithVoicesMessage(
        Math.ceil(timeline.durationInFrames / VIDEO_FPS),
      ),
      plan,
    };
  }

  return {block: null, plan};
};

export const evaluateAudioRenderReadiness = (
  input: ReadinessInput,
): AudioRenderReadiness => {
  const audioDurations = storyHasAudio(input.story)
    ? durationsWithVerified(input.story, input.audioDurations, input.localState)
    : input.audioDurations;

  return {
    ...evaluateWithDurations({...input, audioDurations}),
    audioDurations,
  };
};
