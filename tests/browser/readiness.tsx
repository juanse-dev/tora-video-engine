import {Player, type PlayerRef} from "@remotion/player";
import {useEffect, useRef} from "react";
import {createRoot} from "react-dom/client";
import {ToraVideo} from "../../src/Video.tsx";
import {exampleStory} from "../../src/story/exampleStory.ts";
import {getWebPlayerConfig} from "../../src/web/previewConfig.ts";

declare global {
  interface Window {
    __toraPlayer?: PlayerRef;
  }
}

const config = getWebPlayerConfig(exampleStory);

const Harness = () => {
  const playerRef = useRef<PlayerRef>(null);

  useEffect(() => {
    if (playerRef.current) {
      window.__toraPlayer = playerRef.current;
    }

    return () => {
      delete window.__toraPlayer;
    };
  }, []);

  return (
    <Player
      ref={playerRef}
      component={ToraVideo}
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
