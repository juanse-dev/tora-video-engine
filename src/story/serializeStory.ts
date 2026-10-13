import YAML from "yaml";
import {StorySchema, type Story} from "./schema.ts";
import type {AudioClip, Music} from "./types.ts";

const canonicalClip = (clip: AudioClip) => ({
  src: clip.src,
  ...(clip.volume === undefined ? {} : {volume: clip.volume}),
});

const canonicalMusic = (music: Music) => ({
  ...canonicalClip(music),
  ...(music.fadeIn === undefined ? {} : {fadeIn: music.fadeIn}),
  ...(music.fadeOut === undefined ? {} : {fadeOut: music.fadeOut}),
  ...(music.duck === undefined ? {} : {duck: music.duck}),
});

const canonicalizeStory = (story: Story): Story => ({
  title: story.title,
  ...(story.music === undefined ? {} : {music: canonicalMusic(story.music)}),
  scenes: story.scenes.map((scene) => ({
    type: scene.type,
    pose: scene.pose,
    background: scene.background,
    ...(scene.animation === undefined ? {} : {animation: scene.animation}),
    text: scene.text,
    ...(scene.sfx === undefined ? {} : {sfx: canonicalClip(scene.sfx)}),
    ...(scene.voice === undefined ? {} : {voice: canonicalClip(scene.voice)}),
    duration: scene.duration,
  })),
});

export const serializeStorySource = (story: Story): string => {
  const validated = StorySchema.parse(story);
  return YAML.stringify(canonicalizeStory(validated), {lineWidth: 0});
};
