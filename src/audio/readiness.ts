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

/** The one text for a source that failed a render preflight (metadata or decode). */
export const audioFileUnusableMessage = (name: string): string =>
  `Audio file ${name} cannot be used for rendering.`;
