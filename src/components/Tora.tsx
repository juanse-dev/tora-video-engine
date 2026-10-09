import type {CSSProperties} from "react";
import {Img} from "remotion";
import type {Pose} from "../story/types.ts";
import {MissingAssetPlaceholder} from "./MissingAssetPlaceholder.tsx";
import {useVisualAssetSrc} from "./visualAssetSource.tsx";

type ToraProps = {
  pose: Pose;
  style?: CSSProperties;
};

export const Tora = ({pose, style}: ToraProps) => {
  const asset = useVisualAssetSrc("pose", pose);

  if (asset.kind !== "image") {
    return (
      <MissingAssetPlaceholder
        assetRef={asset.ref}
        category={asset.category}
        variant={asset.kind}
      />
    );
  }

  return (
    <Img
      pauseWhenLoading
      src={asset.src}
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
