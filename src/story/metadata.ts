import type {AudioDurationMap} from "../audio/catalog.ts";
import type {Story} from "./types";
import {compileTimeline} from "./timeline.ts";

export const getStoryMetadata = (
  story: Story,
  fps: number,
  audioDurations: AudioDurationMap,
) => {
  const timeline = compileTimeline(story, fps, audioDurations);

  return {
    durationInFrames: timeline.durationInFrames,
  };
};
