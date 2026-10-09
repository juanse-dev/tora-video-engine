import {backgrounds, poses} from "./story/schema.ts";
import type {
  Animation,
  BundledBackground,
  BundledPose,
} from "./story/types.ts";

export type AssetCategory = "pose" | "background" | "animation";

export type AssetCatalogEntry<T extends string> = {
  id: T;
  label: string;
  category: AssetCategory;
  previewPath: string | null;
  storyValue: T;
};

export type ImageAssetCatalogEntry<T extends string> =
  AssetCatalogEntry<T> & {
    previewPath: string;
  };

export type AnimationAssetCatalogEntry =
  AssetCatalogEntry<Animation> & {
    category: "animation";
    previewPath: null;
  };

export const toraPoseCatalog = {
  formal: {
    id: "formal",
    label: "Formal",
    category: "pose",
    previewPath: "characters/tora/formal.png",
    storyValue: "formal",
  },
  confused: {
    id: "confused",
    label: "Confused",
    category: "pose",
    previewPath: "characters/tora/confused.png",
    storyValue: "confused",
  },
  panic: {
    id: "panic",
    label: "Panic",
    category: "pose",
    previewPath: "characters/tora/panic.png",
    storyValue: "panic",
  },
  coffee: {
    id: "coffee",
    label: "Coffee",
    category: "pose",
    previewPath: "characters/tora/coffee.png",
    storyValue: "coffee",
  },
} as const satisfies Record<BundledPose, ImageAssetCatalogEntry<BundledPose>>;

export const backgroundCatalog = {
  office: {
    id: "office",
    label: "Office",
    category: "background",
    previewPath: "backgrounds/office.png",
    storyValue: "office",
  },
  "server-room": {
    id: "server-room",
    label: "Server room",
    category: "background",
    previewPath: "backgrounds/server-room.png",
    storyValue: "server-room",
  },
} as const satisfies Record<BundledBackground, ImageAssetCatalogEntry<BundledBackground>>;

export const animationCatalog = {
  fade: {
    id: "fade",
    label: "Fade",
    category: "animation",
    previewPath: null,
    storyValue: "fade",
  },
  float: {
    id: "float",
    label: "Float",
    category: "animation",
    previewPath: null,
    storyValue: "float",
  },
  slowZoom: {
    id: "slowZoom",
    label: "Slow zoom",
    category: "animation",
    previewPath: null,
    storyValue: "slowZoom",
  },
} as const satisfies Record<Animation, AnimationAssetCatalogEntry>;

export const toraPoseAssets = Object.fromEntries(
  Object.entries(toraPoseCatalog).map(([id, asset]) => [
    id,
    asset.previewPath,
  ]),
) as Record<BundledPose, string>;

export const backgroundAssets = Object.fromEntries(
  Object.entries(backgroundCatalog).map(([id, asset]) => [
    id,
    asset.previewPath,
  ]),
) as Record<BundledBackground, string>;

export const isBundledPose = (value: string): value is BundledPose =>
  (poses as readonly string[]).includes(value);

export const isBundledBackground = (
  value: string,
): value is BundledBackground =>
  (backgrounds as readonly string[]).includes(value);
