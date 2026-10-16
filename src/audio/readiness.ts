import {
  MAX_BROWSER_STORY_AUDIO_BYTES,
  MAX_BROWSER_STORY_AUDIO_REFS,
} from "../localAssets/limits.ts";
import {
  isAudioPayload,
  type LocalAssetBudgetResult,
  type LocalAudioUsage,
  type PayloadMetadata,
} from "../localAssets/readiness.ts";
import type {Story} from "../story/types.ts";
import type {AudioRef} from "./catalog.ts";
import type {AudioRole} from "./plan.ts";

/** One use of an audio ref by the Story: the music, or the sfx / voice of a scene. */
export type StoryAudioRef = {
  ref: AudioRef;
  role: AudioRole;
  /** 0-based; null for the music. */
  sceneIndex: number | null;
};

/**
 * Every use of an audio ref in the order a person reads the Story: the music,
 * then each scene's sfx and voice. A ref used twice appears twice (once per
 * role), unlike `storyAudioRefs`, which lists distinct refs.
 */
export const collectStoryAudioRefs = (story: Story): StoryAudioRef[] => {
  const uses: StoryAudioRef[] = [];

  if (story.music !== undefined) {
    uses.push({ref: story.music.src, role: "music", sceneIndex: null});
  }

  for (const [sceneIndex, scene] of story.scenes.entries()) {
    if (scene.sfx !== undefined) {
      uses.push({ref: scene.sfx.src, role: "sfx", sceneIndex});
    }

    if (scene.voice !== undefined) {
      uses.push({ref: scene.voice.src, role: "voice", sceneIndex});
    }
  }

  return uses;
};

/** `music`, `scene 3 sfx`, `scene 3 voice` (scenes are 1-based in text). */
export const describeAudioRole = (
  role: AudioRole,
  sceneIndex: number | null,
): string =>
  sceneIndex === null || role === "music"
    ? role
    : `scene ${sceneIndex + 1} ${role}`;

/** The roles in which `ref` is used, as `describeAudioRole` text, in Story order. */
export const describeAudioRefRoles = (story: Story, ref: AudioRef): string[] =>
  collectStoryAudioRefs(story)
    .filter((use) => use.ref === ref)
    .map((use) => describeAudioRole(use.role, use.sceneIndex));

export const bundledAudioUnavailableMessage = (id: string): string =>
  `Bundled audio ${id} is not available in this build.`;

export const bundledAudioMismatchMessage = (id: string): string =>
  `Bundled audio ${id} does not match the catalog.`;

/**
 * Render readiness (exact total, not the acceptance lower bound): the text of the
 * block when `compileTimeline(...)` is longer than the browser's 300 s.
 * `seconds` is the exact total, rounded up to whole seconds.
 */
export const storyTooLongWithVoicesMessage = (seconds: number): string =>
  `This Story is longer than 300 s with its voices (${seconds} s).`;

/** The one text for a source that failed a render preflight (metadata or decode). */
export const audioFileUnusableMessage = (name: string): string =>
  `Audio file ${name} cannot be used for rendering.`;

/**
 * The audio budget of a Story in the browser (D-17), separate from the image
 * budget: it receives audio usages and audio metadata only.
 * refCount = number of usages (missing ones included); bytes are summed once
 * per distinct digest that has metadata. A value equal to its limit passes.
 * Metadata that is not audio fails closed ("metadata"), never as a number.
 */
export const evaluateAudioBudget = (
  usages: readonly LocalAudioUsage[],
  metadataByDigest: ReadonlyMap<string, PayloadMetadata>,
): LocalAssetBudgetResult => {
  const refCount = usages.length;
  let totalBytes = 0;
  let nonAudioMetadata = false;

  for (const digest of new Set(usages.map((usage) => usage.digest))) {
    const metadata = metadataByDigest.get(digest);

    if (metadata === undefined) {
      continue;
    }

    if (!isAudioPayload(metadata) || !Number.isFinite(metadata.byteSize)) {
      nonAudioMetadata = true;
      continue;
    }

    totalBytes += metadata.byteSize;
  }

  const exceeded: Array<"refs" | "bytes" | "pixels" | "metadata"> = [];

  if (refCount > MAX_BROWSER_STORY_AUDIO_REFS) {
    exceeded.push("refs");
  }

  if (totalBytes > MAX_BROWSER_STORY_AUDIO_BYTES) {
    exceeded.push("bytes");
  }

  if (nonAudioMetadata) {
    exceeded.push("metadata");
  }

  // There is no pixel budget for audio: the shared result type carries a 0.
  return exceeded.length === 0
    ? {ok: true, refCount, totalBytes, totalPixels: 0}
    : {ok: false, refCount, totalBytes, totalPixels: 0, exceeded};
};

export const describeAudioBudgetFailure = (
  result: Extract<LocalAssetBudgetResult, {ok: false}>,
): string => {
  const sentences: string[] = [];

  for (const limit of result.exceeded) {
    if (limit === "refs") {
      sentences.push(
        `This Story uses more than ${MAX_BROWSER_STORY_AUDIO_REFS} audio files.`,
      );
    } else if (limit === "bytes") {
      sentences.push(
        `This Story's audio is larger than ${MAX_BROWSER_STORY_AUDIO_BYTES / (1024 * 1024)} MiB.`,
      );
    } else if (limit === "metadata") {
      sentences.push("An audio file's stored details do not match an audio file.");
    }
  }

  return sentences.join(" ");
};
