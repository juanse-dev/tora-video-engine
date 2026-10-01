import YAML from "yaml";
import {StorySchema, type Story} from "./schema.ts";

const canonicalizeStory = (story: Story): Story => ({
  title: story.title,
  scenes: story.scenes.map((scene) => ({
    type: scene.type,
    pose: scene.pose,
    background: scene.background,
    ...(scene.animation === undefined ? {} : {animation: scene.animation}),
    text: scene.text,
    duration: scene.duration,
  })),
});

export const serializeStorySource = (story: Story): string => {
  const validated = StorySchema.parse(story);
  return YAML.stringify(canonicalizeStory(validated), {lineWidth: 0});
};
