import type {Story} from "./types";
import {compileTimeline} from "./timeline";

export const getStoryMetadata = (story: Story, fps: number) => {
  const timeline = compileTimeline(story, fps);

  return {
    durationInFrames: timeline.durationInFrames,
  };
};
