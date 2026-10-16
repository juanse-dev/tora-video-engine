import {
  buildAudioDurationMap,
  type AudioDurationMap,
  type AudioRef,
} from "./catalog.ts";
import type {Story} from "../story/types.ts";

export const storyAudioRefs = (story: Story): AudioRef[] => {
  const refs = new Set<AudioRef>();

  if (story.music !== undefined) {
    refs.add(story.music.src);
  }

  for (const scene of story.scenes) {
    if (scene.sfx !== undefined) {
      refs.add(scene.sfx.src);
    }

    if (scene.voice !== undefined) {
      refs.add(scene.voice.src);
    }
  }

  return [...refs];
};

export const storyHasAudio = (story: Story): boolean =>
  story.music !== undefined ||
  story.scenes.some(
    (scene) =>
      scene.sfx !== undefined ||
      scene.voice !== undefined ||
      scene.duration === "auto",
  );

/** The only way to build a Story duration map: bundled catalog plus the given local durations. */
export const storyAudioDurations = (
  story: Story,
  localDurations: AudioDurationMap = {},
): AudioDurationMap =>
  buildAudioDurationMap(storyAudioRefs(story), localDurations);
