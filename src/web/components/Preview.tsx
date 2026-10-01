import {Player} from "@remotion/player";
import {useCurrentFrame} from "remotion";
import {ToraVideo, type ToraVideoProps} from "../../Video.tsx";
import {exampleStory} from "../../story/exampleStory.ts";
import type {Story} from "../../story/types.ts";
import {getWebPlayerConfig} from "../previewConfig.ts";

type PreviewProps = {
  story?: Story;
};

const FrameProbe = () => {
  const frame = useCurrentFrame();

  return <span data-tora-frame={frame} style={{display: "none"}} />;
};

const WebPreviewVideo = (props: ToraVideoProps) => {
  return (
    <>
      <ToraVideo {...props} />
      <FrameProbe />
    </>
  );
};

export const Preview = ({story = exampleStory}: PreviewProps) => {
  const config = getWebPlayerConfig(story);

  return (
    <div className="preview-frame">
      <Player
        component={WebPreviewVideo}
        inputProps={{story}}
        durationInFrames={config.durationInFrames}
        fps={config.fps}
        compositionWidth={config.compositionWidth}
        compositionHeight={config.compositionHeight}
        controls
        style={{
          width: "100%",
        }}
      />
    </div>
  );
};
