import {Player, type PlayerRef} from "@remotion/player";
import {useEffect, useRef} from "react";
import {ToraVideo} from "../../Video.tsx";
import {exampleStory} from "../../story/exampleStory.ts";
import type {Story} from "../../story/types.ts";
import {getWebPlayerConfig} from "../previewConfig.ts";

type PreviewProps = {
  story?: Story;
};

export const Preview = ({story = exampleStory}: PreviewProps) => {
  const config = getWebPlayerConfig(story);
  const playerRef = useRef<PlayerRef>(null);
  const frameProbeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const player = playerRef.current;

    if (player === null) {
      return;
    }

    const onFrameUpdate = ({detail}: {detail: {frame: number}}) => {
      if (frameProbeRef.current !== null) {
        frameProbeRef.current.dataset.toraFrame = String(detail.frame);
      }
    };

    player.addEventListener("frameupdate", onFrameUpdate);

    return () => {
      player.removeEventListener("frameupdate", onFrameUpdate);
    };
  }, []);

  return (
    <div
      ref={frameProbeRef}
      className="preview-frame"
      data-tora-frame="0"
    >
      <Player
        ref={playerRef}
        component={ToraVideo}
        inputProps={{story}}
        durationInFrames={config.durationInFrames}
        fps={config.fps}
        compositionWidth={config.compositionWidth}
        compositionHeight={config.compositionHeight}
        controls
        errorFallback={({error}) => (
          <div data-preview-error role="alert">
            Preview unavailable: {error.message}
          </div>
        )}
        style={{
          width: "100%",
        }}
      />
    </div>
  );
};
