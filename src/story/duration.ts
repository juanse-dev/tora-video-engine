export const durationToFrames = (
  durationSeconds: number,
  fps: number,
): number => {
  return Math.round(durationSeconds * fps);
};

export const isValidFrameCount = (frames: number): boolean => {
  return Number.isSafeInteger(frames) && frames >= 1;
};
