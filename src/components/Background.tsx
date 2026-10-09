import {AbsoluteFill, Img} from "remotion";
import type {Background as BackgroundName} from "../story/types.ts";
import {MissingAssetPlaceholder} from "./MissingAssetPlaceholder.tsx";
import {useVisualAssetSrc} from "./visualAssetSource.tsx";

type BackgroundProps = {
  background: BackgroundName;
};

export const Background = ({background}: BackgroundProps) => {
  const asset = useVisualAssetSrc("background", background);

  if (asset.kind !== "image") {
    return (
      <AbsoluteFill>
        <MissingAssetPlaceholder
          assetRef={asset.ref}
          category={asset.category}
          variant={asset.kind}
        />
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill>
      <Img
        pauseWhenLoading
        src={asset.src}
        style={{
          height: "100%",
          objectFit: "cover",
          width: "100%",
        }}
      />
    </AbsoluteFill>
  );
};
