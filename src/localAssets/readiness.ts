import type {AudioRole} from "../audio/plan.ts";
import type {Story} from "../story/schema.ts";
import type {
  AudioCodec,
  AudioContainer,
  AudioMimeType,
} from "./audioInspection.ts";
import {
  MAX_BROWSER_STORY_LOCAL_ASSET_BYTES,
  MAX_BROWSER_STORY_LOCAL_ASSET_PIXELS,
  MAX_BROWSER_STORY_LOCAL_ASSET_REFS,
  maxLocalAssetBytes,
} from "./limits.ts";
import {
  isImageAssetCategory,
  isLocalAudioRef,
  parseLocalAssetRef,
  type ImageAssetCategory,
  type LocalAudioRef,
  type LocalImageRef,
} from "./refs.ts";

export type LocalImageUsage = {
  ref: LocalImageRef;
  category: ImageAssetCategory;
  digest: string;
  sceneIndexes: number[]; // 0-based, ascending, a scene appears once per ref
};

export type LocalAudioUsage = {
  ref: LocalAudioRef;
  category: "audio";
  digest: string;
  /** Scenes whose sfx or voice use it, ascending. The Story's music has no scene. */
  sceneIndexes: number[];
  /** Distinct, in first-appearance order (music first). */
  roles: AudioRole[];
};

export type LocalAssetUsage = LocalImageUsage | LocalAudioUsage;

const collectAudioUsages = (story: Story): LocalAudioUsage[] => {
  const byRef = new Map<LocalAudioRef, LocalAudioUsage>();
  const add = (value: string, role: AudioRole, sceneIndex: number | null) => {
    if (!isLocalAudioRef(value)) {
      return;
    }

    let usage = byRef.get(value);

    if (usage === undefined) {
      usage = {
        ref: value,
        category: "audio",
        digest: value.slice(value.length - 64),
        sceneIndexes: [],
        roles: [],
      };
      byRef.set(value, usage);
    }

    if (!usage.roles.includes(role)) {
      usage.roles.push(role);
    }

    if (sceneIndex !== null && !usage.sceneIndexes.includes(sceneIndex)) {
      usage.sceneIndexes.push(sceneIndex);
    }
  };

  if (story.music !== undefined) {
    add(story.music.src, "music", null);
  }

  for (const [sceneIndex, scene] of story.scenes.entries()) {
    if (scene.sfx !== undefined) {
      add(scene.sfx.src, "sfx", sceneIndex);
    }

    if (scene.voice !== undefined) {
      add(scene.voice.src, "voice", sceneIndex);
    }
  }

  return [...byRef.values()];
};

export const splitUsagesByCategory = (
  usages: readonly LocalAssetUsage[],
): {image: LocalImageUsage[]; audio: LocalAudioUsage[]} => {
  const image: LocalImageUsage[] = [];
  const audio: LocalAudioUsage[] = [];

  for (const usage of usages) {
    if (usage.category === "audio") {
      audio.push(usage);
    } else {
      image.push(usage);
    }
  }

  return {image, audio};
};

/**
 * Distinct local refs: image usages first in first-appearance order (scene
 * order, pose before background), then audio usages in storyAudioRefs order.
 */
export const collectStoryLocalAssetUsages = (story: Story): LocalAssetUsage[] => {
  const usagesByRef = new Map<string, LocalImageUsage>();

  for (const [sceneIndex, scene] of story.scenes.entries()) {
    for (const value of [scene.pose, scene.background]) {
      const parsed = parseLocalAssetRef(value);

      if (parsed === null || !isImageAssetCategory(parsed.category)) {
        continue;
      }

      const existing = usagesByRef.get(value);

      if (existing === undefined) {
        usagesByRef.set(value, {
          ref: value as LocalImageRef,
          category: parsed.category,
          digest: parsed.digest,
          sceneIndexes: [sceneIndex],
        });
      } else if (!existing.sceneIndexes.includes(sceneIndex)) {
        existing.sceneIndexes.push(sceneIndex);
      }
    }
  }

  return [...usagesByRef.values(), ...collectAudioUsages(story)];
};

// Image refs only: audio refs are found with collectStoryLocalAssetUsages / storyHasAudio.
export const storyHasLocalAssetRefs = (story: Story): boolean =>
  story.scenes.some(
    (scene) =>
      parseLocalAssetRef(scene.pose) !== null ||
      parseLocalAssetRef(scene.background) !== null,
  );

export type ImagePayloadMetadata = {
  /** Absent in every record this build writes and in every v0.3 record; a stored "image" is tolerated and dropped on read. */
  kind?: "image";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteSize: number;
  width: number;
  height: number;
};

export type AudioPayloadMetadata = {
  kind: "audio";
  mimeType: AudioMimeType;
  byteSize: number;
  container: AudioContainer;
  codec: AudioCodec;
  durationSeconds: number;
  sampleRate: number;
  channels: 1 | 2;
};

export type PayloadMetadata = ImagePayloadMetadata | AudioPayloadMetadata;
export type PayloadKind = "image" | "audio";

export const isAudioPayload = (
  meta: PayloadMetadata,
): meta is AudioPayloadMetadata => meta.kind === "audio";

export const payloadKindOf = (meta: PayloadMetadata): PayloadKind =>
  meta.kind === "audio" ? "audio" : "image";

/** The per-payload ceiling (D-8): images 25 MiB, audio 50 MiB. */
export const maxPayloadBytes = (kind: PayloadKind): number =>
  maxLocalAssetBytes(kind === "audio" ? "audio" : "pose");

export type LocalAssetBudgetResult =
  | {ok: true; refCount: number; totalBytes: number; totalPixels: number}
  | {
      ok: false;
      refCount: number;
      totalBytes: number;
      totalPixels: number;
      exceeded: Array<"refs" | "bytes" | "pixels" | "metadata">;
    };

/**
 * refCount = number of usages (missing/corrupt included).
 * Bytes and pixels are summed once per distinct digest that has metadata.
 * A value equal to its limit passes; one above fails.
 */
export const evaluateLocalAssetBudget = (
  usages: readonly LocalImageUsage[],
  metadataByDigest: ReadonlyMap<string, PayloadMetadata>,
): LocalAssetBudgetResult => {
  const refCount = usages.length;
  let totalBytes = 0;
  let totalPixels = 0;
  let nonImageMetadata = false;

  for (const digest of new Set(usages.map((usage) => usage.digest))) {
    const metadata = metadataByDigest.get(digest);

    if (metadata === undefined) {
      continue;
    }

    if (isAudioPayload(metadata)) {
      nonImageMetadata = true;
      continue;
    }

    totalBytes += metadata.byteSize;
    totalPixels += metadata.width * metadata.height;
  }

  const exceeded: Array<"refs" | "bytes" | "pixels" | "metadata"> = [];

  if (refCount > MAX_BROWSER_STORY_LOCAL_ASSET_REFS) {
    exceeded.push("refs");
  }

  if (totalBytes > MAX_BROWSER_STORY_LOCAL_ASSET_BYTES) {
    exceeded.push("bytes");
  }

  if (totalPixels > MAX_BROWSER_STORY_LOCAL_ASSET_PIXELS) {
    exceeded.push("pixels");
  }

  if (nonImageMetadata) {
    exceeded.push("metadata");
  }

  if (exceeded.length === 0) {
    return {ok: true, refCount, totalBytes, totalPixels};
  }

  return {ok: false, refCount, totalBytes, totalPixels, exceeded};
};

const MIB = 1024 * 1024;
const MEGAPIXEL = 1_000_000;

// Rounds up so a value just over its limit never reads as equal to it.
const formatCeil = (value: number): string =>
  String(Math.ceil(value * 100) / 100);

export const describeBudgetFailure = (
  result: Extract<LocalAssetBudgetResult, {ok: false}>,
): string => {
  const sentences: string[] = [];

  for (const limit of result.exceeded) {
    if (limit === "refs") {
      sentences.push(
        `Uses ${result.refCount} local assets (limit ${MAX_BROWSER_STORY_LOCAL_ASSET_REFS}).`,
      );
    } else if (limit === "bytes") {
      sentences.push(
        `Local assets total ${formatCeil(result.totalBytes / MIB)} MiB (limit ${MAX_BROWSER_STORY_LOCAL_ASSET_BYTES / MIB} MiB).`,
      );
    } else if (limit === "pixels") {
      sentences.push(
        `Local assets total ${formatCeil(result.totalPixels / MEGAPIXEL)} megapixels (limit ${MAX_BROWSER_STORY_LOCAL_ASSET_PIXELS / MEGAPIXEL} megapixels).`,
      );
    } else {
      sentences.push("A local asset's stored details do not match an image.");
    }
  }

  return sentences.join(" ");
};
