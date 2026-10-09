import {AbsoluteFill, Img, staticFile} from "remotion";
import {backgroundAssets, isBundledBackground} from "../assets.ts";
import type {Background as BackgroundName} from "../story/types.ts";

type BackgroundProps = {
  background: BackgroundName;
};

export const Background = ({background}: BackgroundProps) => {
  // Local refs are drawn by a later task; never fall back to a bundled image.
  if (!isBundledBackground(background)) {
    return null;
  }

  return (
    <AbsoluteFill>
      <Img
        pauseWhenLoading
        src={staticFile(backgroundAssets[background])}
        style={{
          height: "100%",
          objectFit: "cover",
          width: "100%",
        }}
      />
    </AbsoluteFill>
  );
};
