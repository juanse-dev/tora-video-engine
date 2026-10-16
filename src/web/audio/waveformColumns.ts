/** The stored peaks of one sound (`WaveformRecord` and the bundled store's `peaks` have this shape). */
export type WaveformPeaks = {
  peaksPerSecond: number;
  peaks: Uint8Array;
};

/**
 * Reduces the first `seconds` of a waveform to `columns` values in [0, 1]: the
 * largest stored peak under each column. A column past the end of the peaks (a
 * track longer than its stored waveform) is 0. Bad input gives zeros, never NaN.
 */
export const waveformColumns = (
  waveform: WaveformPeaks,
  seconds: number,
  columns: number,
): Float32Array => {
  const count = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
  const result = new Float32Array(count);
  const {peaks, peaksPerSecond} = waveform;

  if (
    count === 0 ||
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    !Number.isFinite(peaksPerSecond) ||
    peaksPerSecond <= 0
  ) {
    return result;
  }

  for (let column = 0; column < count; column += 1) {
    const first = Math.floor(((column * seconds) / count) * peaksPerSecond);
    const end = Math.max(
      first + 1,
      Math.ceil((((column + 1) * seconds) / count) * peaksPerSecond),
    );
    let peak = 0;

    for (let index = first; index < end && index < peaks.length; index += 1) {
      if (peaks[index] > peak) {
        peak = peaks[index];
      }
    }

    result[column] = peak / 255;
  }

  return result;
};
