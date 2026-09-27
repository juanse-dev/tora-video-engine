import {AbsoluteFill} from "remotion";
import type {TimelineScene} from "./story/timeline";

type SceneProps = {
  scene: TimelineScene;
  sceneNumber: number;
  totalScenes: number;
};

const sceneBackgrounds = {
  intro: "#111827",
  dialogue: "#1f2937",
  chaos: "#3f1d2e",
  punchline: "#172554",
} as const;

export const Scene = ({
  scene,
  sceneNumber,
  totalScenes,
}: SceneProps) => {
  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        backgroundColor: sceneBackgrounds[scene.type],
        color: "#f9fafb",
        display: "flex",
        fontFamily: "Arial, sans-serif",
        justifyContent: "center",
        padding: 96,
        textAlign: "center",
      }}
    >
      <div>
        <div
          style={{
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: 4,
            opacity: 0.6,
            textTransform: "uppercase",
          }}
        >
          {scene.type} · {sceneNumber}/{totalScenes}
        </div>

        <div
          style={{
            fontSize: 88,
            fontWeight: 700,
            letterSpacing: -3,
            lineHeight: 1.08,
            marginTop: 40,
          }}
        >
          {scene.text}
        </div>

        <div
          style={{
            fontSize: 30,
            lineHeight: 1.4,
            marginTop: 48,
            opacity: 0.5,
          }}
        >
          pose: {scene.pose} · background: {scene.background}
          {scene.animation ? ` · animation: ${scene.animation}` : ""}
        </div>
      </div>
    </AbsoluteFill>
  );
};
