// Shared fixtures for the audio plan tests: three local audio refs with fixed
// durations (music 10 s, voice 2.2 s, sfx 0.4 s) at 30 FPS.
import {compileAudioPlan} from "../../src/audio/plan.ts";
import {compileTimeline} from "../../src/story/timeline.ts";

export const FPS = 30;
export const MUSIC = `local:audio:sha256:${"a".repeat(64)}`;
export const VOICE = `local:audio:sha256:${"b".repeat(64)}`;
export const SFX = `local:audio:sha256:${"c".repeat(64)}`;
export const DURATIONS = {[MUSIC]: 10, [VOICE]: 2.2, [SFX]: 0.4};

export const scene = (overrides = {}) => ({
  type: "dialogue",
  pose: "formal",
  background: "office",
  text: "Hi",
  duration: 3,
  ...overrides,
});

export const makeStory = (scenes, music) => ({
  title: "Plan fixture",
  scenes,
  ...(music === undefined ? {} : {music}),
});

export const allReady = () => "ready";

/** Compiles the timeline and the plan the way the composition does. */
export const buildPlan = (
  story,
  {durations = DURATIONS, sourceState = allReady, fps = FPS} = {},
) => {
  const timeline = compileTimeline(story, fps, durations);

  return compileAudioPlan({
    story,
    timeline,
    fps,
    audioDurations: durations,
    sourceState,
  });
};

export const tracksOf = (plan, role) =>
  plan.tracks.filter((track) => track.role === role);

/** [key, fromFrame, durationInFrames] for every track, in plan order. */
export const shape = (plan) =>
  plan.tracks.map((track) => [track.key, track.fromFrame, track.durationInFrames]);
