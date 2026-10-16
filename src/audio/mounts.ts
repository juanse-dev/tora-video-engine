import type {AudioPlan} from "./plan.ts";
import {
  resolveAudioSrc,
  type AudioSourceMap,
  type BundledAudioPolicy,
} from "./sources.ts";

/** One `<Sequence>` + `<Audio>` pair that `StoryAudio` mounts. */
export type StoryAudioMount = {
  /** Plan key plus the source, so a changed source remounts the element. */
  key: string;
  from: number;
  durationInFrames: number;
  src: string;
  /** Remotion `volume` callback: the frame is relative to the sequence. */
  volumeAt: (frame: number) => number;
  /**
   * A render must not silently decode a source another way (`<Html5Audio>`
   * fallback): set for renders, never for the Player.
   */
  disallowFallbackToHtml5Audio: boolean;
};

/**
 * The elements `StoryAudio` mounts for a plan. Mounts nothing only when
 * `audioArmed` is exactly `false`; absent means armed (Remotion Studio and any
 * composition rendered without a Player play audio).
 */
export const buildStoryAudioMounts = (input: {
  plan: AudioPlan;
  sources: AudioSourceMap | undefined;
  policy: BundledAudioPolicy;
  audioArmed: boolean | undefined;
  /** True while Remotion renders (CLI or browser); false in the Player and Studio. */
  isRendering?: boolean;
}): StoryAudioMount[] => {
  const {plan, sources, policy, audioArmed} = input;
  const disallowFallbackToHtml5Audio = input.isRendering === true;

  if (audioArmed === false) {
    return [];
  }

  return plan.tracks.flatMap((track) => {
    const resolution = resolveAudioSrc(track.ref, sources, policy);

    return resolution.kind === "audio"
      ? [
          {
            key: `${track.key}:${resolution.src}`,
            from: track.fromFrame,
            durationInFrames: track.durationInFrames,
            src: resolution.src,
            volumeAt: (frame: number) => track.gainAt(track.fromFrame + frame),
            disallowFallbackToHtml5Audio,
          },
        ]
      : [];
  });
};
