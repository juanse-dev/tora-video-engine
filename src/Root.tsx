import {Composition} from "remotion";
import {ToraVideo} from "./Video";
import {exampleStory} from "./story/exampleStory";
import {compileTimeline} from "./story/timeline";

const FPS = 30;
const timeline = compileTimeline(exampleStory, FPS);

export const RemotionRoot = () => {
  return (
    <Composition
      id="ToraVideo"
      component={ToraVideo}
      durationInFrames={timeline.durationInFrames}
      fps={FPS}
      width={1080}
      height={1920}
      defaultProps={{story: exampleStory}}
    />
  );
};
