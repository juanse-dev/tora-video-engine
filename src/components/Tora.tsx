import type {CSSProperties} from "react";
import {Img, staticFile} from "remotion";
import {toraPoseAssets} from "../assets.ts";
import type {Pose} from "../story/types.ts";

type ToraProps = {
  pose: Pose;
  style?: CSSProperties;
};

export const Tora = ({pose, style}: ToraProps) => {
  return (
    <Img
      pauseWhenLoading
      src={staticFile(toraPoseAssets[pose])}
      style={{
        display: "block",
        height: "100%",
        objectFit: "contain",
        width: "100%",
        ...style,
      }}
    />
  );
};
