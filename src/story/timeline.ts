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

  const scenes = story.scenes.map((scene) => {
    const durationInFrames = Math.round(scene.duration * fps);
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
