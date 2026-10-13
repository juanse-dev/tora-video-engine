import type {AudioDurationMap} from "../audio/catalog.ts";
import type {Story} from "../story/types.ts";
import {getStoryMetadata} from "../story/metadata.ts";
import {VIDEO_FPS, VIDEO_HEIGHT, VIDEO_WIDTH} from "../videoConfig.ts";

export const getWebPlayerConfig = (
  story: Story,
  audioDurations: AudioDurationMap,
) => {
  const metadata = getStoryMetadata(story, VIDEO_FPS, audioDurations);

  return {
    compositionHeight: VIDEO_HEIGHT,
    compositionWidth: VIDEO_WIDTH,
    durationInFrames: metadata.durationInFrames,
    fps: VIDEO_FPS,
  };
};
