import type {CalculateMetadataFunction} from "remotion";
import {Composition} from "remotion";
import {ToraVideo, type ToraVideoProps} from "./Video";
import {exampleStory} from "./story/exampleStory";
import {getStoryMetadata} from "./story/metadata";
import {VIDEO_FPS, VIDEO_HEIGHT, VIDEO_WIDTH} from "./videoConfig";
const defaultMetadata = getStoryMetadata(exampleStory, VIDEO_FPS);

const calculateMetadata: CalculateMetadataFunction<ToraVideoProps> = ({
  props,
}) => {
  return getStoryMetadata(props.story, VIDEO_FPS);
};

export const RemotionRoot = () => {
  return (
    <Composition
      id="ToraVideo"
      component={ToraVideo}
      durationInFrames={defaultMetadata.durationInFrames}
      fps={VIDEO_FPS}
      width={VIDEO_WIDTH}
      height={VIDEO_HEIGHT}
      defaultProps={{story: exampleStory}}
      calculateMetadata={calculateMetadata}
    />
  );
};
