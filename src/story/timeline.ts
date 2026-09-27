import {durationToFrames, isValidFrameCount} from "./duration.ts";
import type {Story, StoryScene} from "./types";

export type TimelineScene = StoryScene & {
  from: number;
  durationInFrames: number;
};

export type Timeline = {
  scenes: TimelineScene[];
  durationInFrames: number;
};

export const compileTimeline = (story: Story, fps: number): Timeline => {
  let from = 0;

  const scenes = story.scenes.map((scene, index) => {
    const durationInFrames = durationToFrames(scene.duration, fps);

    if (!isValidFrameCount(durationInFrames)) {
      throw new Error(
        `Scene ${index} ("${scene.text}") must compile to a finite safe frame count of at least 1; got ${durationInFrames} frames from duration=${scene.duration}s at ${fps} FPS.`,
      );
    }

    const timelineScene: TimelineScene = {
      ...scene,
      from,
      durationInFrames,
    };

    from += durationInFrames;

    return timelineScene;
  });

  return {
    scenes,
    durationInFrames: from,
  };
};
