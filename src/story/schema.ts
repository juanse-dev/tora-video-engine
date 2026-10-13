import {z} from "zod";
import {isAudioRef, type AudioRef} from "../audio/catalog.ts";
import {MAX_FADE_SECONDS} from "../audio/constants.ts";
import {isCaptionLayoutSupported} from "../captionLayout.ts";
import {isCaptionTextSupported} from "../fontCoverage.ts";
import {
  isLocalBackgroundRef,
  isLocalPoseRef,
  type LocalBackgroundRef,
  type LocalPoseRef,
} from "../localAssets/refs.ts";
import {scenePresets} from "../scenePresets.ts";
import {VIDEO_FPS} from "../videoConfig.ts";
import {
  captionCodePointLength,
  MAX_CAPTION_LENGTH,
} from "./constraints.ts";
import {
  addFrameCounts,
  durationToFrames,
  isValidFrameCount,
} from "./duration.ts";

export const sceneTypes = ["intro", "dialogue", "chaos", "punchline"] as const;
export const poses = ["formal", "confused", "panic", "coffee"] as const;
export const backgrounds = ["office", "server-room"] as const;
export const animations = ["fade", "float", "slowZoom"] as const;

export const SceneTypeSchema = z.enum(sceneTypes);
export const BundledPoseSchema = z.enum(poses);
export const BundledBackgroundSchema = z.enum(backgrounds);
export const AnimationSchema = z.enum(animations);

export type BundledPose = z.infer<typeof BundledPoseSchema>;
export type BundledBackground = z.infer<typeof BundledBackgroundSchema>;

export const PoseSchema = z.custom<BundledPose | LocalPoseRef>(
  (value) =>
    typeof value === "string" &&
    (BundledPoseSchema.safeParse(value).success || isLocalPoseRef(value)),
  {
    message:
      "Pose must be formal, confused, panic, coffee, or local:pose:sha256:<64 lowercase hex>",
  },
);

export const BackgroundSchema = z.custom<
  BundledBackground | LocalBackgroundRef
>(
  (value) =>
    typeof value === "string" &&
    (BundledBackgroundSchema.safeParse(value).success ||
      isLocalBackgroundRef(value)),
  {
    message:
      "Background must be office, server-room, or local:background:sha256:<64 lowercase hex>",
  },
);

const UnitIntervalSchema = z.number().finite().min(0).max(1);
const FadeSecondsSchema = z.number().finite().min(0).max(MAX_FADE_SECONDS);

export const AudioRefSchema = z.custom<AudioRef>(
  (value) => typeof value === "string" && isAudioRef(value),
  {
    message:
      "Audio must be whoosh, boom, ding, pop, calm-loop, upbeat-loop, or local:audio:sha256:<64 lowercase hex>",
  },
);

export const AudioClipSchema = z
  .object({
    src: AudioRefSchema,
    volume: UnitIntervalSchema.optional(),
  })
  .strict();

export const MusicSchema = z
  .object({
    src: AudioRefSchema,
    volume: UnitIntervalSchema.optional(),
    fadeIn: FadeSecondsSchema.optional(),
    fadeOut: FadeSecondsSchema.optional(),
    duck: UnitIntervalSchema.optional(),
  })
  .strict();

const FixedDurationSchema = z
  .number()
  .finite()
  .positive()
  .refine(
    (duration) => isValidFrameCount(durationToFrames(duration, VIDEO_FPS)),
    {
      message: `Duration must produce a finite safe frame count of at least 1 at ${VIDEO_FPS} FPS`,
    },
  );

const SceneDurationSchema = z
  .custom<number | "auto">(() => true)
  .superRefine((value, context) => {
    if (value === "auto") {
      return;
    }

    const result = FixedDurationSchema.safeParse(value);

    if (!result.success) {
      for (const issue of result.error.issues) {
        context.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path,
          continue: issue.code !== "invalid_type",
        });
      }
    }
  });

export const StorySceneSchema = z
  .object({
    type: SceneTypeSchema,
    pose: PoseSchema,
    background: BackgroundSchema,
    text: z
      .string()
      .min(1, "Text must not be empty")
      .refine(
        (text) => captionCodePointLength(text) <= MAX_CAPTION_LENGTH,
        {
          message: `Text must contain at most ${MAX_CAPTION_LENGTH} Unicode code points`,
        },
      )
      .refine(isCaptionTextSupported, {
        message:
          "Text contains characters unsupported by the bundled caption renderer",
      }),
    duration: SceneDurationSchema,
    animation: AnimationSchema.optional(),
    sfx: AudioClipSchema.optional(),
    voice: AudioClipSchema.optional(),
  })
  .strict()
  .superRefine((scene, context) => {
    if (scene.duration === "auto" && scene.voice === undefined) {
      context.addIssue({
        code: "custom",
        path: ["duration"],
        message: "duration: auto requires a voice",
      });
    }

    if (
      captionCodePointLength(scene.text) > MAX_CAPTION_LENGTH ||
      !isCaptionTextSupported(scene.text)
    ) {
      return;
    }

    const variant = scenePresets[scene.type].captionVariant;

    if (!isCaptionLayoutSupported(variant, scene.text)) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message:
          "Text cannot fit within the deterministic caption layout at the minimum font size",
      });
    }
  });

export const StorySchema = z
  .object({
    title: z.string().min(1, "Title must not be empty"),
    scenes: z
      .array(StorySceneSchema)
      .min(1, "Story must contain at least one scene"),
    music: MusicSchema.optional(),
  })
  .strict()
  .superRefine((story, context) => {
    let totalFrames = 0;

    for (const [index, scene] of story.scenes.entries()) {
      if (scene.duration === "auto") {
        continue;
      }

      const sceneFrames = durationToFrames(scene.duration, VIDEO_FPS);

      if (!isValidFrameCount(sceneFrames)) {
        continue;
      }

      const nextTotal = addFrameCounts(totalFrames, sceneFrames);

      if (nextTotal === null) {
        context.addIssue({
          code: "custom",
          path: ["scenes", index, "duration"],
          message: `Cumulative story duration must remain within the safe integer frame range at ${VIDEO_FPS} FPS`,
        });
        break;
      }

      totalFrames = nextTotal;
    }
  });

export type SceneType = z.infer<typeof SceneTypeSchema>;
export type Pose = z.infer<typeof PoseSchema>;
export type Background = z.infer<typeof BackgroundSchema>;
export type Animation = z.infer<typeof AnimationSchema>;
export type StoryScene = z.infer<typeof StorySceneSchema>;
export type Story = z.infer<typeof StorySchema>;
export type AudioClip = z.infer<typeof AudioClipSchema>;
export type Music = z.infer<typeof MusicSchema>;
