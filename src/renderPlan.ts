import {scenePresets, type ScenePreset} from "./scenePresets.ts";
import {compileTimeline} from "./story/timeline.ts";
import type {Animation, Background, Pose, SceneType, Story} from "./story/types.ts";

export type SceneRenderPlan = {
  from: number;
  durationInFrames: number;
  type: SceneType;
  pose: Pose;
  background: Background;
  text: string;
  animation: Animation | undefined;
  preset: ScenePreset;
};

export type StoryRenderPlan = {
  scenes: SceneRenderPlan[];
  durationInFrames: number;
};

export const buildStoryRenderPlan = (
  story: Story,
  fps: number,
): StoryRenderPlan => {
  const timeline = compileTimeline(story, fps);

  return {
    durationInFrames: timeline.durationInFrames,
    scenes: timeline.scenes.map((scene) => {
      const preset: ScenePreset = scenePresets[scene.type];

      return {
        from: scene.from,
        durationInFrames: scene.durationInFrames,
        type: scene.type,
        pose: scene.pose,
        background: scene.background,
        text: scene.text,
        animation: scene.animation ?? preset.defaultAnimation,
        preset,
      };
    }),
  };
};
