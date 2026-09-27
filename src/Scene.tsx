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
import {scenePresets, type ScenePreset} from "./scenePresets.ts";
import type {Animation} from "./story/types.ts";
import type {TimelineScene} from "./story/timeline";

type SceneProps = {
  scene: TimelineScene;
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
  const preset: ScenePreset = scenePresets[scene.type];
  const animation: Animation | undefined =
    scene.animation ?? preset.defaultAnimation;

  const animationStyle: CSSProperties = (() => {
    const styles: Record<Animation, () => CSSProperties> = {
      fade: () => fade(frame, fps, scene.durationInFrames),
      float: () => float(frame, fps),
      slowZoom: () => slowZoom(frame, scene.durationInFrames),
    };

    return animation ? styles[animation]() : {};
  })();

  return (
    <AbsoluteFill style={{overflow: "hidden"}}>
      <Background background={scene.background} />

      <AbsoluteFill
        style={{
          background: preset.overlay,
        }}
      />

      <AbsoluteFill
        style={{
          ...animationStyle,
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
          <Tora pose={scene.pose} />
        </div>

        <Caption
          text={scene.text}
          variant={preset.captionVariant}
          placement={preset.captionPlacement}
          align={preset.captionAlign}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
