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
    const durationInFrames = Math.round(scene.duration * fps);

    if (durationInFrames < 1) {
      throw new Error(
        `Scene ${index} ("${scene.text}") must compile to at least 1 frame; got ${durationInFrames} frames from duration=${scene.duration}s at ${fps} FPS.`,
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
