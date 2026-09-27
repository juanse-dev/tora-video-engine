import type {CalculateMetadataFunction} from "remotion";
import {Composition} from "remotion";
import {ToraVideo, type ToraVideoProps} from "./Video";
import {exampleStory} from "./story/exampleStory";
import {getStoryMetadata} from "./story/metadata";

const FPS = 30;
const defaultMetadata = getStoryMetadata(exampleStory, FPS);

const calculateMetadata: CalculateMetadataFunction<ToraVideoProps> = ({
  props,
}) => {
  return getStoryMetadata(props.story, FPS);
};

export const RemotionRoot = () => {
  return (
    <Composition
      id="ToraVideo"
      component={ToraVideo}
      durationInFrames={defaultMetadata.durationInFrames}
      fps={FPS}
      width={1080}
      height={1920}
      defaultProps={{story: exampleStory}}
      calculateMetadata={calculateMetadata}
    />
  );
};
