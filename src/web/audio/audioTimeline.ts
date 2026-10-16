import type {AudioRef} from "../../audio/catalog.ts";
import type {AudioPlanTrack, AudioRole} from "../../audio/plan.ts";
import type {Timeline} from "../../story/timeline.ts";
import type {EditorAudioPlanView} from "./audioPlanView.ts";

/** A horizontal extent as percentages of the whole Story length. */
export type Span = {leftPct: number; widthPct: number};

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/** `fromFrame` and `durationInFrames` as percentages of `totalFrames`, kept inside the Story. */
export const frameSpan = (
  fromFrame: number,
  durationInFrames: number,
  totalFrames: number,
): Span => {
  if (totalFrames <= 0) {
    return {leftPct: 0, widthPct: 0};
  }

  const left = clamp(fromFrame, 0, totalFrames);
  const right = clamp(fromFrame + durationInFrames, left, totalFrames);

  return {
    leftPct: (left / totalFrames) * 100,
    widthPct: ((right - left) / totalFrames) * 100,
  };
};

export type SceneBlock = Span & {
  index: number;
  /** 1-based, as the scene list shows it. */
  number: number;
};

/** One block per scene, proportional to its `durationInFrames`. */
export const sceneBlocks = (timeline: Timeline): SceneBlock[] =>
  timeline.scenes.map((scene, index) => ({
    index,
    number: index + 1,
    ...frameSpan(scene.from, scene.durationInFrames, timeline.durationInFrames),
  }));

export type TimelineLane = "music" | "effects";
/** Effects and voices share the effects lane in two bands so they never overlap each other. */
export type TimelineBand = "music" | "sfx" | "voice";

export const bandOfRole = (role: AudioRole): TimelineBand => role;
export const laneOfRole = (role: AudioRole): TimelineLane =>
  role === "music" ? "music" : "effects";

export const roleLabel = (role: AudioRole): string =>
  role === "music" ? "Music" : role === "sfx" ? "Sound effect" : "Voice";

export const trackSpan = (track: AudioPlanTrack, totalFrames: number): Span =>
  frameSpan(track.fromFrame, track.durationInFrames, totalFrames);

export type TimelinePlaceholder = Span & {
  key: string;
  band: TimelineBand;
  lane: TimelineLane;
  role: AudioRole;
  ref: AudioRef;
  sceneIndex: number | null;
  /** Missing or unusable audio is hatched; audio that is still loading is plain. */
  appearance: "hatched" | "plain";
  label: string;
};

const usableSeconds = (seconds: number | undefined): seconds is number =>
  typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0;

/**
 * One block for every sound the plan could not emit a track for: `missing-audio`
 * is hatched, `pending-audio` is plain, both carry the role label. A block has
 * the length the track would have (the plan's own sfx and voice clamps) when
 * the sound's duration is known, otherwise its scene's length; the music spans
 * the Story.
 */
export const timelinePlaceholders = (
  view: EditorAudioPlanView,
): TimelinePlaceholder[] => {
  const {timeline, plan, fps, audioDurations} = view;
  const total = timeline.durationInFrames;

  return plan.issues.flatMap((issue): TimelinePlaceholder[] => {
    if (issue.kind !== "missing-audio" && issue.kind !== "pending-audio") {
      return [];
    }

    const scene =
      issue.sceneIndex === null ? undefined : timeline.scenes[issue.sceneIndex];
    let from = 0;
    let length = total;

    if (issue.sceneIndex !== null) {
      if (scene === undefined) {
        return [];
      }

      const seconds = audioDurations[issue.ref];
      const known = usableSeconds(seconds)
        ? Math.max(1, Math.round(seconds * fps))
        : scene.durationInFrames;

      from = scene.from;
      length =
        issue.role === "voice"
          ? Math.min(known, scene.durationInFrames)
          : Math.min(known, total - scene.from);
    }

    return [
      {
        key: `${issue.kind}:${issue.role}:${issue.sceneIndex ?? "story"}`,
        band: bandOfRole(issue.role),
        lane: laneOfRole(issue.role),
        role: issue.role,
        ref: issue.ref,
        sceneIndex: issue.sceneIndex,
        appearance: issue.kind === "missing-audio" ? "hatched" : "plain",
        label: roleLabel(issue.role),
        ...frameSpan(from, length, total),
      },
    ];
  });
};

/** The playhead's left edge, in percent of the Story length. */
export const playheadPercent = (frame: number, totalFrames: number): number =>
  totalFrames <= 0 ? 0 : clamp((frame / totalFrames) * 100, 0, 100);

/** The frame under a pointer `offsetX` pixels from the left of a `width` px wide timeline. */
export const frameFromPointer = (
  offsetX: number,
  width: number,
  totalFrames: number,
): number =>
  width <= 0 || totalFrames <= 0
    ? 0
    : clamp(Math.floor((offsetX / width) * totalFrames), 0, totalFrames - 1);

/** The scene that contains `frame` (the last one starting at or before it). */
export const sceneIndexAtFrame = (timeline: Timeline, frame: number): number => {
  let index = 0;

  for (const [candidate, scene] of timeline.scenes.entries()) {
    if (scene.from <= frame) {
      index = candidate;
    }
  }

  return index;
};

/**
 * Where a key moves the playhead, or null when the key is not a timeline key.
 * `ArrowRight` goes to the next scene start (the last frame when there is none),
 * `ArrowLeft` to the previous scene start (the first frame when there is none),
 * `Home` and `End` to the first and last frame.
 */
export const seekTarget = (
  key: string,
  frame: number,
  timeline: Timeline,
): number | null => {
  const last = Math.max(0, timeline.durationInFrames - 1);

  switch (key) {
    case "Home":
      return 0;
    case "End":
      return last;
    case "ArrowRight": {
      const next = timeline.scenes.find((scene) => scene.from > frame);

      return next === undefined ? last : next.from;
    }
    case "ArrowLeft": {
      const previous = [...timeline.scenes]
        .reverse()
        .find((scene) => scene.from < frame);

      return previous === undefined ? 0 : previous.from;
    }
    default:
      return null;
  }
};

const clock = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));

  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/** What a screen reader hears: the current scene and the time, `Audio timeline, scene 2 of 3, 0:03 of 0:09`. */
export const timelineLabel = (
  frame: number,
  timeline: Timeline,
  fps: number,
): string =>
  `Audio timeline, scene ${sceneIndexAtFrame(timeline, frame) + 1} of ${timeline.scenes.length}, ${clock(frame / fps)} of ${clock(timeline.durationInFrames / fps)}`;

/**
 * The music envelope for display, sampled ONCE per column: `columns` values
 * (never more than one per frame) at the centre frame of each column. The
 * envelope is the plan's `musicEnvelopeAt`; this only reads it.
 */
export const sampleEnvelope = (
  envelopeAt: (frame: number) => number,
  totalFrames: number,
  columns: number,
): Float32Array => {
  const count = Math.min(
    Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0,
    Math.max(0, totalFrames),
  );
  const samples = new Float32Array(count);

  for (let index = 0; index < count; index += 1) {
    const frame = Math.min(
      totalFrames - 1,
      Math.floor(((index + 0.5) * totalFrames) / count),
    );

    samples[index] = clamp(envelopeAt(frame), 0, 1);
  }

  return samples;
};
