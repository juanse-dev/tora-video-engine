import {Audio} from "@remotion/media";
import {useMemo} from "react";
import {Sequence, useRemotionEnvironment} from "remotion";
import type {AudioDurationMap} from "../audio/catalog.ts";
import {buildStoryAudioMounts} from "../audio/mounts.ts";
import {compileAudioPlan} from "../audio/plan.ts";
import {audioSourceState, resolveAudioSrc} from "../audio/sources.ts";
import type {Timeline} from "../story/timeline.ts";
import type {Story} from "../story/types.ts";
import {useAudioSources} from "./audioSources.tsx";

const NO_AUDIO_DURATIONS: AudioDurationMap = {};

type StoryAudioProps = {
  story: Story;
  /** The very timeline `ToraVideo` compiled for `StoryRenderer`. */
  timeline: Timeline;
  fps: number;
  audioDurations: AudioDurationMap | undefined;
  /** Mounts no `<Audio>` only when exactly `false`; see `buildStoryAudioMounts`. */
  audioArmed: boolean | undefined;
};

/** Turns the audio plan into `<Sequence>` + `<Audio>` elements (AINV-4). */
export const StoryAudio = ({
  story,
  timeline,
  fps,
  audioDurations,
  audioArmed,
}: StoryAudioProps) => {
  const {sources, policy} = useAudioSources();
  // Renders (CLI and browser) never fall back to another decode path; the
  // Player keeps the default so a browser that cannot decode a file still plays it.
  const {isRendering} = useRemotionEnvironment();
  const plan = useMemo(
    () =>
      compileAudioPlan({
        story,
        timeline,
        fps,
        audioDurations: audioDurations ?? NO_AUDIO_DURATIONS,
        sourceState: (ref) =>
          audioSourceState(resolveAudioSrc(ref, sources, policy)),
      }),
    [story, timeline, fps, audioDurations, sources, policy],
  );
  const mounts = useMemo(
    () =>
      buildStoryAudioMounts({plan, sources, policy, audioArmed, isRendering}),
    [plan, sources, policy, audioArmed, isRendering],
  );

  return (
    <>
      {mounts.map((mount) => (
        <Sequence
          key={mount.key}
          from={mount.from}
          durationInFrames={mount.durationInFrames}
          layout="none"
        >
          <Audio
            src={mount.src}
            volume={(frame) => mount.volumeAt(frame)}
            disallowFallbackToHtml5Audio={mount.disallowFallbackToHtml5Audio}
          />
        </Sequence>
      ))}
    </>
  );
};
