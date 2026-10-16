import {compileAudioPlan, type AudioPlan} from "../../audio/plan.ts";
import type {AudioDurationMap} from "../../audio/catalog.ts";
import {
  audioSourceState,
  resolveAudioSrc,
  type AudioSourceMap,
} from "../../audio/sources.ts";
import {compileTimeline, type Timeline} from "../../story/timeline.ts";
import type {Story} from "../../story/types.ts";

/** The timeline and the audio plan the editor shows (the Player's own, recompiled from the same inputs). */
export type EditorAudioPlanView = {
  timeline: Timeline;
  plan: AudioPlan;
  fps: number;
  audioDurations: AudioDurationMap;
};

/**
 * Compiles, for the editor's timeline and warnings, exactly what `StoryAudio`
 * compiles inside the Player: the same Story, the same duration map, the same
 * source map and the `"explicit"` policy. The UI only reads the plan; it never
 * recomputes mixing (AINV-4).
 */
export const compileEditorAudioPlan = (input: {
  story: Story;
  fps: number;
  audioDurations: AudioDurationMap;
  audioSources: AudioSourceMap;
}): EditorAudioPlanView => {
  const {story, fps, audioDurations, audioSources} = input;
  const timeline = compileTimeline(story, fps, audioDurations);
  const plan = compileAudioPlan({
    story,
    timeline,
    fps,
    audioDurations,
    sourceState: (ref) =>
      audioSourceState(resolveAudioSrc(ref, audioSources, "explicit")),
  });

  return {timeline, plan, fps, audioDurations};
};
