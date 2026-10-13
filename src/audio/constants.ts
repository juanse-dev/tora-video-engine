export const AUTO_DURATION_PADDING_SECONDS = 0.5;
export const AUTO_DURATION_FALLBACK_SECONDS = 3;
export const MAX_FADE_SECONDS = 10;
export const DEFAULT_AUDIO_VOLUME = 1;
export const DEFAULT_MUSIC_DUCK = 0.35;
export const DUCK_RAMP_SECONDS = 0.15;
export const DUCK_MERGE_GAP_SECONDS = 0.3;
export const MUSIC_CROSSFADE_SECONDS = 0.3;
export const MIN_LOOPING_MUSIC_SECONDS = 1;
export const MAX_AUDIO_STORY_SECONDS = 3_600;
export const OUTPUT_AUDIO_SAMPLE_RATE = 48_000;
export const OUTPUT_AUDIO_BITRATE = 128_000;
export const WAVEFORM_PEAKS_PER_SECOND = 50;
export const MAX_WAVEFORM_PEAKS = 15_000;

/** The fewest frames an `auto` scene can have: a voice is > 0 s long. */
export const autoDurationMinFrames = (fps: number): number =>
  Math.ceil(AUTO_DURATION_PADDING_SECONDS * fps) + 1;
