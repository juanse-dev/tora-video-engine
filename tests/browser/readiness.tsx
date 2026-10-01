import {Player} from "@remotion/player";
import {useEffect} from "react";
import {createRoot} from "react-dom/client";
import {useCurrentFrame} from "remotion";
import {ToraVideo, type ToraVideoProps} from "../../src/Video.tsx";
import {exampleStory} from "../../src/story/exampleStory.ts";
import {getWebPlayerConfig} from "../../src/web/previewConfig.ts";

const config = getWebPlayerConfig(exampleStory);

const ProbeVideo = (props: ToraVideoProps) => {
  const frame = useCurrentFrame();

  useEffect(() => {
    document.documentElement.dataset.toraFrame = String(frame);

    return () => {
      delete document.documentElement.dataset.toraFrame;
    };
  }, [frame]);

  return <ToraVideo {...props} />;
};

const Harness = () => {
  return (
    <Player
      component={ProbeVideo}
      inputProps={{story: exampleStory}}
      durationInFrames={config.durationInFrames}
      fps={config.fps}
      compositionWidth={config.compositionWidth}
      compositionHeight={config.compositionHeight}
      autoPlay
      controls={false}
      bufferStateDelayInMilliseconds={0}
      acknowledgeRemotionLicense
      style={{width: 320}}
    />
  );
};

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Missing readiness harness root");
}

createRoot(root).render(<Harness />);
