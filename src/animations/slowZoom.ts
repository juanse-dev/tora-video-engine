import type {CSSProperties} from "react";
import {interpolate} from "remotion";

export const slowZoom = (
  frame: number,
  durationInFrames: number,
): CSSProperties => {
  if (durationInFrames <= 1) {
    return {transform: "scale(1)"};
  }

  const scale = interpolate(
    frame,
    [0, durationInFrames - 1],
    [1, 1.055],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  return {
    transform: `scale(${scale})`,
  };
};
