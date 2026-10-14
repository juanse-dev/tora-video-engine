import type {LocalAssetCategory} from "./refs.ts";

export const MAX_LOCAL_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_LOCAL_ASSET_DIMENSION = 8192;
export const MAX_LOCAL_ASSET_PIXELS = 50_000_000;
export const MAX_BROWSER_STORY_LOCAL_ASSET_REFS = 64;
export const MAX_BROWSER_STORY_LOCAL_ASSET_BYTES = 256 * 1024 * 1024;
export const MAX_BROWSER_STORY_LOCAL_ASSET_PIXELS = 200_000_000;
export const MAX_LOCAL_AUDIO_BYTES = 50 * 1024 * 1024;
export const MAX_AUDIO_DURATION_SECONDS = 300;
export const MIN_AUDIO_SAMPLE_RATE = 8_000;
export const MAX_AUDIO_SAMPLE_RATE = 96_000;
export const MAX_AUDIO_CHANNELS = 2;
export const MAX_BROWSER_STORY_AUDIO_REFS = 64;
export const MAX_BROWSER_STORY_AUDIO_BYTES = 256 * 1024 * 1024;
export const AUDIO_TRUNCATION_TOLERANCE_SECONDS = 0.25;

/** The largest accepted file for one category (images 25 MiB, audio 50 MiB). */
export const maxLocalAssetBytes = (category: LocalAssetCategory): number =>
  category === "audio" ? MAX_LOCAL_AUDIO_BYTES : MAX_LOCAL_ASSET_BYTES;
