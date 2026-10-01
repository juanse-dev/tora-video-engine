import {AbsoluteFill, Img, staticFile} from "remotion";
import {backgroundAssets} from "../assets.ts";
import type {Background as BackgroundName} from "../story/types.ts";

type BackgroundProps = {
  background: BackgroundName;
};

export const Background = ({background}: BackgroundProps) => {
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
