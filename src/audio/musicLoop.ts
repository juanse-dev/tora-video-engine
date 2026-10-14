import {
  MIN_LOOPING_MUSIC_SECONDS,
  MUSIC_CROSSFADE_SECONDS,
} from "./constants.ts";

export type MusicCopy = {
  /** Position in `copies`; the plan key is `music-${index}`. */
  index: number;
  fromFrame: number;
  durationInFrames: number;
};

export type MusicLoopPlan = {
  copies: MusicCopy[];
  /** Overlap `X` between consecutive copies; 0 when the copies abut or there is one. */
  crossfadeFrames: number;
  /** True when the music is shorter than the minimum looping length and the Story is longer than it. */
  tooShortToLoop: boolean;
};

/**
 * Splits the music into overlapping copies that cover the Story (D-4).
 * Every length is at least one frame; copy starts are `k * (D - X)`.
 */
export const planMusicLoop = (input: {
  musicSeconds: number;
  totalFrames: number;
  fps: number;
  /** Defaults to MUSIC_CROSSFADE_SECONDS; a parameter so tests can exercise the clamp. */
  crossfadeSeconds?: number;
}): MusicLoopPlan => {
  const {
    musicSeconds,
    totalFrames,
    fps,
    crossfadeSeconds = MUSIC_CROSSFADE_SECONDS,
  } = input;
  const musicFrames = Math.max(1, Math.round(musicSeconds * fps));

  if (musicFrames >= totalFrames) {
    return {
      copies: [{index: 0, fromFrame: 0, durationInFrames: totalFrames}],
      crossfadeFrames: 0,
      tooShortToLoop: false,
    };
  }

  if (musicSeconds < MIN_LOOPING_MUSIC_SECONDS) {
    return {
      copies: [{index: 0, fromFrame: 0, durationInFrames: musicFrames}],
      crossfadeFrames: 0,
      tooShortToLoop: true,
    };
  }

  const crossfadeFrames = Math.min(
    Math.round(crossfadeSeconds * fps),
    Math.floor(musicFrames / 2),
  );
  const stride = musicFrames - crossfadeFrames;
  const copies: MusicCopy[] = [];

  for (let start = 0; start < totalFrames; start += stride) {
    copies.push({
      index: copies.length,
      fromFrame: start,
      durationInFrames: Math.min(musicFrames, totalFrames - start),
    });
  }

  return {copies, crossfadeFrames, tooShortToLoop: false};
};

/**
 * Equal-power crossfade factor of one copy on one frame (D-4): the incoming
 * copy follows `sin(pi*u/2)` over its first `X` frames, the outgoing copy
 * `cos(pi*u/2)` over the `X` frames where the next copy starts, with
 * `u = (frame - overlapStart + 0.5) / X`. 1 everywhere else.
 */
export const crossfadeFactorAt = (
  loop: MusicLoopPlan,
  copyIndex: number,
  frame: number,
): number => {
  const {copies, crossfadeFrames: overlap} = loop;

  if (overlap === 0) {
    return 1;
  }

  let factor = 1;
  const copy = copies[copyIndex];

  if (
    copyIndex > 0 &&
    frame >= copy.fromFrame &&
    frame < copy.fromFrame + overlap
  ) {
    factor *= Math.sin(
      (Math.PI / 2) * ((frame - copy.fromFrame + 0.5) / overlap),
    );
  }

  const next = copies[copyIndex + 1];

  if (
    next !== undefined &&
    frame >= next.fromFrame &&
    frame < next.fromFrame + overlap
  ) {
    factor *= Math.cos(
      (Math.PI / 2) * ((frame - next.fromFrame + 0.5) / overlap),
    );
  }

  return factor;
};

export type ResolvedFades = {
  fadeInSeconds: number;
  fadeOutSeconds: number;
  /** True when `fadeIn + fadeOut` exceeded the Story and both were scaled down (D-5). */
  scaled: boolean;
};

export const resolveFades = (input: {
  fadeInSeconds: number;
  fadeOutSeconds: number;
  totalFrames: number;
  fps: number;
}): ResolvedFades => {
  const {fadeInSeconds, fadeOutSeconds, totalFrames, fps} = input;
  const storySeconds = totalFrames / fps;
  const sum = fadeInSeconds + fadeOutSeconds;

  if (sum > storySeconds) {
    const scale = storySeconds / sum;

    return {
      fadeInSeconds: fadeInSeconds * scale,
      fadeOutSeconds: fadeOutSeconds * scale,
      scaled: true,
    };
  }

  return {fadeInSeconds, fadeOutSeconds, scaled: false};
};

/** Linear fade-in from frame 0 and fade-out to `totalFrames`, in [0, 1]. */
export const fadeFactorAt = (input: {
  frame: number;
  totalFrames: number;
  fps: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
}): number => {
  const {frame, totalFrames, fps, fadeInSeconds, fadeOutSeconds} = input;
  const fadeInFrames = fadeInSeconds * fps;
  const fadeOutFrames = fadeOutSeconds * fps;
  const fadeIn =
    fadeInFrames > 0 ? Math.min(1, Math.max(0, frame / fadeInFrames)) : 1;
  const fadeOut =
    fadeOutFrames > 0
      ? Math.min(1, Math.max(0, (totalFrames - frame) / fadeOutFrames))
      : 1;

  return fadeIn * fadeOut;
};
