import {
  addFrameCounts,
  durationToFrames,
  isValidFrameCount,
} from "./duration.ts";
import type {AudioDurationMap} from "../audio/catalog.ts";
import {
  AUTO_DURATION_FALLBACK_SECONDS,
  AUTO_DURATION_PADDING_SECONDS,
  autoDurationMinFrames,
} from "../audio/constants.ts";
import type {Story, StoryScene} from "./types";

export type TimelineScene = StoryScene & {
  from: number;
  durationInFrames: number;
  durationSource: "fixed" | "voice" | "fallback";
};

export type Timeline = {
  scenes: TimelineScene[];
  durationInFrames: number;
};

const sceneFrames = (
  scene: StoryScene,
  fps: number,
  audioDurations: AudioDurationMap,
): {
  durationInFrames: number;
  durationSource: TimelineScene["durationSource"];
} => {
  if (scene.duration !== "auto") {
    return {
      durationInFrames: durationToFrames(scene.duration, fps),
      durationSource: "fixed",
    };
  }

  const seconds =
    scene.voice === undefined ? undefined : audioDurations[scene.voice.src];

  return typeof seconds === "number"
    ? {
        durationInFrames: Math.ceil(
          (seconds + AUTO_DURATION_PADDING_SECONDS) * fps,
        ),
        durationSource: "voice",
      }
    : {
        durationInFrames: durationToFrames(AUTO_DURATION_FALLBACK_SECONDS, fps),
        durationSource: "fallback",
      };
};

/** Frames of the Story with every `auto` scene at its lower bound. */
export const minimumStoryFrames = (story: Story, fps: number): number =>
  story.scenes.reduce(
    (total, scene) =>
      total +
      (scene.duration === "auto"
        ? autoDurationMinFrames(fps)
        : durationToFrames(scene.duration, fps)),
    0,
  );

export const compileTimeline = (
  story: Story,
  fps: number,
  audioDurations: AudioDurationMap,
): Timeline => {
  let from = 0;

  const scenes = story.scenes.map((scene, index) => {
    const {durationInFrames, durationSource} = sceneFrames(
      scene,
      fps,
      audioDurations,
    );

    if (!isValidFrameCount(durationInFrames)) {
      throw new Error(
        `Scene ${index} ("${scene.text}") must compile to a finite safe frame count of at least 1; got ${durationInFrames} frames from duration=${scene.duration}s at ${fps} FPS.`,
      );
    }

    const nextFrom = addFrameCounts(from, durationInFrames);

    if (nextFrom === null) {
      throw new Error(
        `Scene ${index} ("${scene.text}") causes the cumulative timeline to exceed the safe integer frame range; current=${from}, durationInFrames=${durationInFrames}.`,
      );
    }

    const timelineScene: TimelineScene = {
      ...scene,
      from,
      durationInFrames,
      durationSource,
    };

    from = nextFrom;

    return timelineScene;
  });

  return {
    scenes,
    durationInFrames: from,
  };
};
