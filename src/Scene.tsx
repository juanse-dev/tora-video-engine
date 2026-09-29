import type {CSSProperties} from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {fade} from "./animations/fade.ts";
import {float} from "./animations/float.ts";
import {slowZoom} from "./animations/slowZoom.ts";
import {Background} from "./components/Background.tsx";
import {Caption} from "./components/Caption.tsx";
import {Tora} from "./components/Tora.tsx";
import type {SceneRenderPlan} from "./renderPlan.ts";

type SceneProps = {
  scene: SceneRenderPlan;
};

const placementStyle = (
  placement: "left" | "center" | "right",
): CSSProperties => {
  if (placement === "left") {
    return {left: 72};
  }

  if (placement === "right") {
    return {right: 72};
  }

  return {
    left: "50%",
    transform: "translateX(-50%)",
  };
};

export const Scene = ({scene}: SceneProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {animation, preset} = scene;

  const fadeStyle: CSSProperties =
    animation === "fade"
      ? fade(frame, fps, scene.durationInFrames)
      : {};

  const foregroundAnimationStyle: CSSProperties =
    animation === "slowZoom"
      ? slowZoom(frame, scene.durationInFrames)
      : {};

  const toraAnimationStyle: CSSProperties =
    animation === "float" ? float(frame, fps) : {};

  return (
    <AbsoluteFill style={{overflow: "hidden"}}>
      <AbsoluteFill style={fadeStyle}>
        <Background background={scene.background} />

        <AbsoluteFill
          style={{
            background: preset.overlay,
          }}
        />

        <AbsoluteFill
          style={{
            ...foregroundAnimationStyle,
            transformOrigin: "center center",
          }}
        >
          <div
            style={{
              ...placementStyle(preset.toraPlacement),
              bottom: preset.toraBottom,
              height: preset.toraWidth * 1.18,
              position: "absolute",
              width: preset.toraWidth,
            }}
          >
            <div
              style={{
                height: "100%",
                width: "100%",
                ...toraAnimationStyle,
              }}
            >
              <Tora pose={scene.pose} />
            </div>
          </div>

          <Caption
            text={scene.text}
            variant={preset.captionVariant}
            placement={preset.captionPlacement}
            align={preset.captionAlign}
          />
        </AbsoluteFill>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
