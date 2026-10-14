import type {Story} from "../story/types.ts";
import type {Timeline} from "../story/timeline.ts";
import type {AudioDurationMap, AudioRef} from "./catalog.ts";
import {maxSimultaneousGain} from "./clipping.ts";
import {
  DEFAULT_AUDIO_VOLUME,
  DEFAULT_MUSIC_DUCK,
  DUCK_MERGE_GAP_SECONDS,
  DUCK_RAMP_SECONDS,
  MAX_AUDIO_STORY_SECONDS,
} from "./constants.ts";
import {
  createDuckGain,
  mergeDuckWindows,
  type DuckWindow,
} from "./ducking.ts";
import {
  crossfadeFactorAt,
  fadeFactorAt,
  planMusicLoop,
  resolveFades,
} from "./musicLoop.ts";
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

  // Bounds the number of music copies (at most 5,143 at 30 FPS) in every caller.
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

  const musicSeconds =
    story.music === undefined
      ? null
      : readySeconds(story.music.src, "music", null);
  const musicLoop =
    musicSeconds === null
      ? null
      : planMusicLoop({musicSeconds, totalFrames, fps});

  if (musicLoop?.tooShortToLoop === true) {
    issues.push({kind: "music-too-short-to-loop"});
  }

  const fades =
    story.music === undefined || musicLoop === null
      ? null
      : resolveFades({
          fadeInSeconds: story.music.fadeIn ?? 0,
          fadeOutSeconds: story.music.fadeOut ?? 0,
          totalFrames,
          fps,
        });

  if (fades?.scaled === true) {
    issues.push({kind: "fades-scaled"});
  }

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

  const musicTracks: AudioPlanTrack[] = [];
  let musicEnvelopeAt: AudioPlan["musicEnvelopeAt"] = null;

  if (story.music !== undefined && musicLoop !== null && fades !== null) {
    const windows: DuckWindow[] = sceneTracks.map((track) => ({
      start: track.fromFrame,
      end: track.fromFrame + track.durationInFrames,
    }));
    const duckGainAt = createDuckGain(
      mergeDuckWindows(
        windows,
        Math.round(DUCK_MERGE_GAP_SECONDS * fps),
      ),
      {
        duck: clamp01(story.music.duck ?? DEFAULT_MUSIC_DUCK),
        rampFrames: Math.round(DUCK_RAMP_SECONDS * fps),
      },
    );
    const volume = clamp01(story.music.volume ?? DEFAULT_AUDIO_VOLUME);
    const envelopeAt = (frame: number): number =>
      clamp01(
        volume *
          fadeFactorAt({
            frame,
            totalFrames,
            fps,
            fadeInSeconds: fades.fadeInSeconds,
            fadeOutSeconds: fades.fadeOutSeconds,
          }) *
          duckGainAt(frame),
      );

    musicEnvelopeAt = envelopeAt;

    for (const copy of musicLoop.copies) {
      musicTracks.push({
        key: `music-${copy.index}`,
        role: "music",
        ref: story.music.src,
        sceneIndex: null,
        fromFrame: copy.fromFrame,
        durationInFrames: copy.durationInFrames,
        gainAt: (frame) =>
          envelopeAt(frame) * crossfadeFactorAt(musicLoop, copy.index, frame),
      });
    }
  }

  const tracks = [...musicTracks, ...sceneTracks];

  return {
    tracks,
    issues,
    maxSimultaneousGain: maxSimultaneousGain(tracks),
    musicEnvelopeAt,
  };
};
