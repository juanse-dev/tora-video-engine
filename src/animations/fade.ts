import type {CSSProperties} from "react";
import {interpolate} from "remotion";

export const fade = (
  frame: number,
  fps: number,
  durationInFrames: number,
): CSSProperties => {
  if (durationInFrames <= 1) {
    return {opacity: 1};
  }

  const fadeInFrames = Math.max(
    1,
    Math.min(Math.round(fps * 0.35), durationInFrames - 1),
  );

  return {
    opacity: interpolate(frame, [0, fadeInFrames], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
  };
};
