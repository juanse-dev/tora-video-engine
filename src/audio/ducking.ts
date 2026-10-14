/** A half-open frame interval `[start, end)` where an sfx or a voice sounds. */
export type DuckWindow = {start: number; end: number};

/**
 * Sorts the windows and merges those whose gap is smaller than
 * `mergeGapFrames` (overlapping windows have a negative gap and always merge).
 */
export const mergeDuckWindows = (
  windows: readonly DuckWindow[],
  mergeGapFrames: number,
): DuckWindow[] => {
  const sorted = [...windows].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );
  const merged: DuckWindow[] = [];

  for (const window of sorted) {
    const last = merged[merged.length - 1];

    if (last !== undefined && window.start - last.end < mergeGapFrames) {
      last.end = Math.max(last.end, window.end);
    } else {
      merged.push({start: window.start, end: window.end});
    }
  }

  return merged;
};

/**
 * Music gain factor for ducking (D-6): 1 outside the windows, `duck` inside, a
 * linear ramp 1 -> duck over `[start - ramp, start)` and duck -> 1 over
 * `[end, end + ramp)`. Overlapping ramps take the minimum. `windows` must come
 * from `mergeDuckWindows`.
 */
export const createDuckGain = (
  windows: readonly DuckWindow[],
  options: {duck: number; rampFrames: number},
): ((frame: number) => number) => {
  const {duck, rampFrames} = options;

  if (duck >= 1 || windows.length === 0) {
    return () => 1;
  }

  const windowGain = (window: DuckWindow, frame: number): number => {
    if (frame >= window.start && frame < window.end) {
      return duck;
    }

    if (frame < window.start) {
      return frame >= window.start - rampFrames
        ? 1 - ((1 - duck) * (frame - (window.start - rampFrames))) / rampFrames
        : 1;
    }

    return frame < window.end + rampFrames
      ? duck + ((1 - duck) * (frame - window.end)) / rampFrames
      : 1;
  };

  return (frame) => {
    // First window whose trailing ramp has not ended yet (ends ascend).
    let low = 0;
    let high = windows.length;

    while (low < high) {
      const middle = (low + high) >> 1;

      if (windows[middle].end + rampFrames > frame) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }

    let gain = 1;

    for (
      let index = low;
      index < windows.length && windows[index].start - rampFrames <= frame;
      index += 1
    ) {
      gain = Math.min(gain, windowGain(windows[index], frame));
    }

    return gain;
  };
};
