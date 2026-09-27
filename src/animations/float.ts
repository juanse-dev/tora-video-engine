import type {CSSProperties} from "react";

export const float = (frame: number, fps: number): CSSProperties => {
  const seconds = frame / fps;
  const offset = Math.sin((seconds * Math.PI * 2) / 3) * 14;

  return {
    transform: `translateY(${offset}px)`,
  };
};
