import {Composition} from "remotion";
import {ToraVideo} from "./Video";

export const RemotionRoot = () => {
  return (
    <Composition
      id="ToraVideo"
      component={ToraVideo}
      durationInFrames={90}
      fps={30}
      width={1080}
      height={1920}
    />
  );
};
