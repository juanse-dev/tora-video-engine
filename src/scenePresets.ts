import type {Animation, SceneType} from "./story/types.ts";

export type CaptionVariant = "hero" | "dialogue" | "impact";
export type CaptionPlacement = "top" | "bottom";
export type HorizontalPlacement = "left" | "center" | "right";

export type ScenePreset = {
  captionVariant: CaptionVariant;
  captionPlacement: CaptionPlacement;
  captionAlign: "left" | "center";
  defaultAnimation?: Animation;
  toraWidth: number;
  toraBottom: number;
  toraPlacement: HorizontalPlacement;
  overlay: string;
};

export const scenePresets = {
  intro: {
    captionVariant: "hero",
    captionPlacement: "top",
    captionAlign: "center",
    defaultAnimation: "fade",
    toraWidth: 680,
    toraBottom: 235,
    toraPlacement: "center",
    overlay: "rgba(8, 18, 28, 0.16)",
  },
  dialogue: {
    captionVariant: "dialogue",
    captionPlacement: "bottom",
    captionAlign: "left",
    defaultAnimation: "float",
    toraWidth: 640,
    toraBottom: 360,
    toraPlacement: "left",
    overlay: "rgba(8, 18, 28, 0.10)",
  },
  chaos: {
    captionVariant: "impact",
    captionPlacement: "top",
    captionAlign: "center",
    toraWidth: 770,
    toraBottom: 215,
    toraPlacement: "center",
    overlay: "rgba(120, 12, 24, 0.28)",
  },
  punchline: {
    captionVariant: "hero",
    captionPlacement: "bottom",
    captionAlign: "center",
    defaultAnimation: "slowZoom",
    toraWidth: 625,
    toraBottom: 355,
    toraPlacement: "right",
    overlay: "rgba(18, 12, 6, 0.12)",
  },
} as const satisfies Record<SceneType, ScenePreset>;
