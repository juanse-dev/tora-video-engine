import {
  backgroundAssets,
  isBundledBackground,
  isBundledPose,
  toraPoseAssets,
} from "../assets.ts";
import type {Background, Pose} from "../story/types.ts";
import type {LocalAssetCategory, LocalAssetRef} from "./refs.ts";
import {isLocalAssetRef} from "./refs.ts";

export const STAGED_LOCAL_ASSETS_DIR = "__local-assets";

/**
 * Runtime-only description of where a local asset's bytes can be loaded from.
 * Values are passed as props and never persisted or serialized (INV-1).
 */
export type LocalAssetSource =
  | {kind: "url"; url: string} // browser: blob: object URL
  | {kind: "static"; path: string} // CLI: path inside the temporary public dir
  | {kind: "pending"}; // browser preview: still resolving (never passed to a render)

export type LocalAssetSourceMap = Readonly<
  Partial<Record<LocalAssetRef, LocalAssetSource>>
>;

/** "abcd…7890": first 4 and last 4 hex chars of the digest. */
export const shortAssetId = (ref: LocalAssetRef): string =>
  `${ref.slice(ref.length - 64, ref.length - 60)}…${ref.slice(ref.length - 4)}`;

export type VisualAssetResolution =
  | {kind: "image"; src: string}
  | {kind: "pending"; category: LocalAssetCategory; ref: LocalAssetRef}
  | {kind: "missing"; category: LocalAssetCategory; ref: LocalAssetRef};

/**
 * Pure resolution of a Story pose/background value to something drawable.
 * Never falls back to another image for a local ref (INV-5).
 */
export const resolveVisualAssetSrc = (
  category: LocalAssetCategory,
  value: Pose | Background,
  sources: LocalAssetSourceMap | undefined,
  toStaticUrl: (path: string) => string,
): VisualAssetResolution => {
  if (category === "pose" && isBundledPose(value)) {
    return {kind: "image", src: toStaticUrl(toraPoseAssets[value])};
  }

  if (category === "background" && isBundledBackground(value)) {
    return {kind: "image", src: toStaticUrl(backgroundAssets[value])};
  }

  const ref = value as LocalAssetRef;

  if (!isLocalAssetRef(ref) || !ref.startsWith(`local:${category}:`)) {
    return {kind: "missing", category, ref};
  }

  const source =
    sources !== undefined && Object.prototype.hasOwnProperty.call(sources, ref)
      ? sources[ref]
      : undefined;

  if (source === undefined) {
    return {kind: "missing", category, ref};
  }

  switch (source.kind) {
    case "url":
      return {kind: "image", src: source.url};
    case "static":
      return {kind: "image", src: toStaticUrl(source.path)};
    case "pending":
      return {kind: "pending", category, ref};
  }
};
