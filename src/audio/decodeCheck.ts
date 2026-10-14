import {AUDIO_TRUNCATION_TOLERANCE_SECONDS} from "../localAssets/limits.ts";

/**
 * D-9, the one truncation rule: a decode is complete when something was
 * decoded and it is at most `min(tolerance, duration / 2)` shorter than the
 * duration the container declares. The `> 0` term and the half-duration cap
 * keep short clips honest (a 0.12 s clip that decodes to nothing never passes).
 */
export const isDecodeComplete = (
  decodedSeconds: number,
  durationSeconds: number,
): boolean =>
  decodedSeconds > 0 &&
  decodedSeconds >=
    durationSeconds -
      Math.min(AUDIO_TRUNCATION_TOLERANCE_SECONDS, durationSeconds / 2);
