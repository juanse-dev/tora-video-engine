import {serializeStorySource} from "../story/serializeStory.ts";
import {getStoryMetadata} from "../story/metadata.ts";
import type {Story} from "../story/types.ts";
import {VIDEO_FPS} from "../videoConfig.ts";

export const MAX_BROWSER_TITLE_CODE_UNITS = 65_536;
export const MAX_BROWSER_ACTIVE_SCENES = 200;
export const MAX_BROWSER_TOTAL_FRAMES = 9_000;
export const MAX_BROWSER_CANONICAL_YAML_BYTES = 1_048_576;
export const MAX_VISUAL_CAPTION_CODE_UNITS = 360;
export const MAX_VISUAL_DRAFT_SCENES = 201;

export type BrowserStoryPolicyRejectionReason =
  | "title"
  | "scene-count"
  | "duration"
  | "canonical-yaml";

export type BrowserStoryPolicyResult =
  | {
      eligible: true;
      totalFrames: number;
      canonicalSource: string;
      canonicalBytes: number;
    }
  | {
      eligible: false;
      reason: BrowserStoryPolicyRejectionReason;
      message: string;
    };

export type BrowserStoryPolicyDependencies = {
  deriveTotalFrames?: (story: Story) => number;
  serialize?: (story: Story) => string;
  utf8ByteLength?: (source: string) => number;
};

const defaultDeriveTotalFrames = (story: Story): number =>
  getStoryMetadata(story, VIDEO_FPS).durationInFrames;

const defaultUtf8ByteLength = (source: string): number =>
  new TextEncoder().encode(source).byteLength;

export const evaluateBrowserStoryPolicy = (
  story: Story,
  dependencies: BrowserStoryPolicyDependencies = {},
): BrowserStoryPolicyResult => {
  if (story.title.length > MAX_BROWSER_TITLE_CODE_UNITS) {
    return {
      eligible: false,
      reason: "title",
      message:
        "Title exceeds the browser editor limit of 65,536 UTF-16 code units. Use YAML/CLI for larger schema-valid titles.",
    };
  }

  if (story.scenes.length > MAX_BROWSER_ACTIVE_SCENES) {
    return {
      eligible: false,
      reason: "scene-count",
      message:
        "Browser authoring supports at most 200 active scenes. Delete a scene or continue through a YAML/CLI workflow.",
    };
  }

  const deriveTotalFrames =
    dependencies.deriveTotalFrames ?? defaultDeriveTotalFrames;
  const totalFrames = deriveTotalFrames(story);

  if (totalFrames > MAX_BROWSER_TOTAL_FRAMES) {
    return {
      eligible: false,
      reason: "duration",
      message:
        "Browser authoring supports at most 9,000 frames (300 seconds at 30 FPS). Reduce scene durations or use YAML/CLI.",
    };
  }

  const serialize = dependencies.serialize ?? serializeStorySource;
  const canonicalSource = serialize(story);
  const utf8ByteLength =
    dependencies.utf8ByteLength ?? defaultUtf8ByteLength;
  const canonicalBytes = utf8ByteLength(canonicalSource);

  if (canonicalBytes > MAX_BROWSER_CANONICAL_YAML_BYTES) {
    return {
      eligible: false,
      reason: "canonical-yaml",
      message:
        "Canonical Story YAML exceeded the browser round-trip safety limit. Browser limits must be revisited before this Story can become active.",
    };
  }

  return {
    eligible: true,
    totalFrames,
    canonicalSource,
    canonicalBytes,
  };
};
