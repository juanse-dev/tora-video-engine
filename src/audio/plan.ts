import type {Story} from "../story/types.ts";
import type {Timeline} from "../story/timeline.ts";
import type {AudioDurationMap, AudioRef} from "./catalog.ts";
import {maxSimultaneousGain} from "./clipping.ts";
import {DEFAULT_AUDIO_VOLUME, MAX_AUDIO_STORY_SECONDS} from "./constants.ts";
import {storyHasAudio} from "./storyAudio.ts";

export type AudioRole = "music" | "sfx" | "voice";

export type AudioPlanTrack = {
  /** Stable: "music-0", "music-1", "sfx-3", "voice-3". */
  key: string;
  role: AudioRole;
  ref: AudioRef;
  /** null for music. */
  sceneIndex: number | null;
  /** Absolute composition frame. */
  fromFrame: number;
  /** At least 1. */
  durationInFrames: number;
  /** In [0, 1]; pure; defined for [fromFrame, fromFrame + durationInFrames). */
  gainAt: (absoluteFrame: number) => number;
};

export type AudioPlanIssue =
  | {
      kind: "missing-audio";
      ref: AudioRef;
      role: AudioRole;
      sceneIndex: number | null;
    }
  | {
      kind: "pending-audio";
      ref: AudioRef;
      role: AudioRole;
      sceneIndex: number | null;
    }
  | {kind: "voice-cut"; sceneIndex: number; seconds: number}
  | {kind: "fades-scaled"}
  | {kind: "music-too-short-to-loop"}
  | {kind: "story-too-long-for-audio"};

export type AudioPlan = {
  tracks: readonly AudioPlanTrack[];
  issues: readonly AudioPlanIssue[];
  maxSimultaneousGain: number;
  /** The music's single-source envelope `volume x fade x duckGain` (no crossfade factors), for display; null without music. */
  musicEnvelopeAt: ((absoluteFrame: number) => number) | null;
};

export type AudioSourceState = "ready" | "pending" | "missing";

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** A sub-frame source (AINV-7 only requires > 0) still gets one frame. */
const frameLength = (seconds: number, fps: number): number =>
  Math.max(1, Math.round(seconds * fps));

const isUsableDuration = (seconds: number | undefined): seconds is number =>
  typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0;

const emptyPlan = (issues: readonly AudioPlanIssue[] = []): AudioPlan => ({
  tracks: [],
  issues,
  maxSimultaneousGain: 0,
  musicEnvelopeAt: null,
});

export const compileAudioPlan = (input: {
  story: Story;
  timeline: Timeline;
  fps: number;
  audioDurations: AudioDurationMap;
  sourceState: (ref: AudioRef) => AudioSourceState;
}): AudioPlan => {
  const {story, timeline, fps, audioDurations, sourceState} = input;

  if (!storyHasAudio(story)) {
    return emptyPlan();
  }

  const totalFrames = timeline.durationInFrames;

  // Bounds the work (and, with music, the copy count) in every caller.
  if (totalFrames > MAX_AUDIO_STORY_SECONDS * fps) {
    return emptyPlan([{kind: "story-too-long-for-audio"}]);
  }

  const issues: AudioPlanIssue[] = [];

  /** The ref's duration when its source is ready and measured; otherwise records exactly one issue. */
  const readySeconds = (
    ref: AudioRef,
    role: AudioRole,
    sceneIndex: number | null,
  ): number | null => {
    const state = sourceState(ref);

    if (state === "missing") {
      issues.push({kind: "missing-audio", ref, role, sceneIndex});

      return null;
    }

    const seconds = audioDurations[ref];

    if (state === "pending" || !isUsableDuration(seconds)) {
      issues.push({kind: "pending-audio", ref, role, sceneIndex});

      return null;
    }

    return seconds;
  };

  const sceneTracks: AudioPlanTrack[] = [];

  timeline.scenes.forEach((scene, sceneIndex) => {
    if (scene.sfx !== undefined) {
      const seconds = readySeconds(scene.sfx.src, "sfx", sceneIndex);

      if (seconds !== null) {
        const volume = clamp01(scene.sfx.volume ?? DEFAULT_AUDIO_VOLUME);

        sceneTracks.push({
          key: `sfx-${sceneIndex}`,
          role: "sfx",
          ref: scene.sfx.src,
          sceneIndex,
          fromFrame: scene.from,
          durationInFrames: Math.min(
            frameLength(seconds, fps),
            totalFrames - scene.from,
          ),
          gainAt: () => volume,
        });
      }
    }

    if (scene.voice !== undefined) {
      const seconds = readySeconds(scene.voice.src, "voice", sceneIndex);

      if (seconds !== null) {
        const volume = clamp01(scene.voice.volume ?? DEFAULT_AUDIO_VOLUME);
        const fullFrames = frameLength(seconds, fps);

        if (scene.duration !== "auto" && fullFrames > scene.durationInFrames) {
          issues.push({
            kind: "voice-cut",
            sceneIndex,
            seconds: (fullFrames - scene.durationInFrames) / fps,
          });
        }

        sceneTracks.push({
          key: `voice-${sceneIndex}`,
          role: "voice",
          ref: scene.voice.src,
          sceneIndex,
          fromFrame: scene.from,
          durationInFrames: Math.min(fullFrames, scene.durationInFrames),
          gainAt: () => volume,
        });
      }
    }
  });

  return {
    tracks: sceneTracks,
    issues,
    maxSimultaneousGain: maxSimultaneousGain(sceneTracks),
    musicEnvelopeAt: null,
  };
};
