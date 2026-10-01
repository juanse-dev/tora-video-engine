import {Player} from "@remotion/player";
import {ToraVideo} from "../../Video.tsx";
import {exampleStory} from "../../story/exampleStory.ts";
import type {Story} from "../../story/types.ts";
import {getWebPlayerConfig} from "../previewConfig.ts";

type PreviewProps = {
  story?: Story;
};

export const Preview = ({story = exampleStory}: PreviewProps) => {
  const config = getWebPlayerConfig(story);

  return (
    <div className="preview-frame">
      <Player
        component={ToraVideo}
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
