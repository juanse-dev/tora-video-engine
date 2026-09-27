export const durationToFrames = (
  durationSeconds: number,
  fps: number,
): number => {
  return Math.round(durationSeconds * fps);
};

export const isValidFrameCount = (frames: number): boolean => {
  return Number.isSafeInteger(frames) && frames >= 1;
};

export const addFrameCounts = (
  currentFrames: number,
  additionalFrames: number,
): number | null => {
  const total = currentFrames + additionalFrames;

  return Number.isSafeInteger(total) && total >= 0 ? total : null;
};
