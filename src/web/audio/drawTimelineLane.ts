import type {AudioPlanTrack} from "../../audio/plan.ts";
import type {EditorAudioPlanView} from "./audioPlanView.ts";
import {sampleEnvelope, trackSpan} from "./audioTimeline.ts";
import {drawWaveformBars, type WaveformContext} from "./drawWaveform.ts";
import {waveformColumns, type WaveformPeaks} from "./waveformColumns.ts";

/** The canvas members the lanes use (a recording fake in Node tests). */
export type LaneContext = WaveformContext & {
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  beginPath: () => void;
  moveTo: (x: number, y: number) => void;
  lineTo: (x: number, y: number) => void;
  stroke: () => void;
};

export const MUSIC_WAVEFORM_COLOR = "#64748b";
export const MUSIC_ENVELOPE_COLOR = "#f8fafc";
export const SFX_WAVEFORM_COLOR = "#f59e0b";
export const VOICE_WAVEFORM_COLOR = "#38bdf8";

/** A track whose peaks are not available is drawn as a quiet flat bar, so it is still visibly there. */
const PLACEHOLDER_LEVEL = 0.08;

type LaneInput = {
  view: EditorAudioPlanView;
  waveforms: ReadonlyMap<string, WaveformPeaks>;
  /** CSS pixels. */
  width: number;
  height: number;
};

const drawTrack = (
  context: LaneContext,
  track: AudioPlanTrack,
  input: LaneInput,
  area: {y: number; height: number},
  color: string,
) => {
  const {view, waveforms, width} = input;
  const span = trackSpan(track, view.timeline.durationInFrames);
  const x = (span.leftPct / 100) * width;
  const trackWidth = Math.max(1, (span.widthPct / 100) * width);
  const columns = Math.max(1, Math.round(trackWidth));
  const peaks = waveforms.get(track.ref);
  const values =
    peaks === undefined
      ? new Float32Array(columns).fill(PLACEHOLDER_LEVEL)
      : waveformColumns(peaks, track.durationInFrames / view.fps, columns);

  drawWaveformBars(
    context,
    values,
    {x, y: area.y, width: trackWidth, height: area.height},
    color,
  );
};

/**
 * The music lane: every music copy of the plan with its waveform (each copy
 * from the start of the sound, at its own `fromFrame`), then the plan's gain
 * envelope (`musicEnvelopeAt`: fades x ducking, no crossfade factors) as a
 * line, sampled once per column. Nothing is mixed here (AINV-4).
 */
export const drawMusicLane = (context: LaneContext, input: LaneInput): void => {
  const {view, width, height} = input;
  const copies = view.plan.tracks.filter((track) => track.role === "music");

  context.clearRect(0, 0, width, height);

  for (const track of copies) {
    drawTrack(context, track, input, {y: 0, height}, MUSIC_WAVEFORM_COLOR);
  }

  const envelope = view.plan.musicEnvelopeAt;

  if (envelope === null || copies.length === 0 || width < 1) {
    return;
  }

  const samples = sampleEnvelope(
    envelope,
    view.timeline.durationInFrames,
    Math.round(width),
  );

  context.strokeStyle = MUSIC_ENVELOPE_COLOR;
  context.lineWidth = 1.5;
  context.beginPath();

  for (const [index, gain] of samples.entries()) {
    const x = ((index + 0.5) / samples.length) * width;
    const y = height - gain * height;

    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }

  context.stroke();
};

/** The effects/voice lane: sound effects in the upper half, voices in the lower half, each at its `fromFrame`. */
export const drawEffectsLane = (context: LaneContext, input: LaneInput): void => {
  const {view, width, height} = input;
  const half = height / 2;

  context.clearRect(0, 0, width, height);

  for (const track of view.plan.tracks) {
    if (track.role === "sfx") {
      drawTrack(context, track, input, {y: 0, height: half}, SFX_WAVEFORM_COLOR);
    } else if (track.role === "voice") {
      drawTrack(context, track, input, {y: half, height: half}, VOICE_WAVEFORM_COLOR);
    }
  }
};
