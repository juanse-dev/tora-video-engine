import {z} from "zod";
import {VIDEO_FPS} from "../videoConfig.ts";

export const sceneTypes = ["intro", "dialogue", "chaos", "punchline"] as const;
export const poses = ["formal", "confused", "panic", "coffee"] as const;
export const backgrounds = ["office", "server-room"] as const;
export const animations = ["fade", "float", "slowZoom"] as const;

export const SceneTypeSchema = z.enum(sceneTypes);
export const PoseSchema = z.enum(poses);
export const BackgroundSchema = z.enum(backgrounds);
export const AnimationSchema = z.enum(animations);

export const StorySceneSchema = z
  .object({
    type: SceneTypeSchema,
    pose: PoseSchema,
    background: BackgroundSchema,
    text: z.string().min(1, "Text must not be empty"),
    duration: z
      .number()
      .finite()
      .positive()
      .refine((duration) => Math.round(duration * VIDEO_FPS) >= 1, {
        message: `Duration must produce at least 1 frame at ${VIDEO_FPS} FPS`,
      }),
    animation: AnimationSchema.optional(),
  })
  .strict();

export const StorySchema = z
  .object({
    title: z.string().min(1, "Title must not be empty"),
    scenes: z
      .array(StorySceneSchema)
      .min(1, "Story must contain at least one scene"),
  })
  .strict();

export type SceneType = z.infer<typeof SceneTypeSchema>;
export type Pose = z.infer<typeof PoseSchema>;
export type Background = z.infer<typeof BackgroundSchema>;
export type Animation = z.infer<typeof AnimationSchema>;
export type StoryScene = z.infer<typeof StorySceneSchema>;
export type Story = z.infer<typeof StorySchema>;
