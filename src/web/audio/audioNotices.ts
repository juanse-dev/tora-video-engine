import type {AudioRef, BundledAudio} from "../../audio/catalog.ts";
import {bundledAudioCatalog, isBundledAudio} from "../../audio/catalog.ts";
import type {AudioRole} from "../../audio/plan.ts";
import type {EditorAudioPlanView} from "./audioPlanView.ts";
import {
  BUNDLED_AUDIO_FETCH_FAILED_MESSAGE,
  type BundledAudioState,
} from "./bundledAudio.ts";

export const AUDIO_NOT_AVAILABLE_MESSAGE = "Audio not available: render blocked.";
export const AUDIO_NOT_LOADED_MESSAGE = BUNDLED_AUDIO_FETCH_FAILED_MESSAGE;
export const FADES_SCALED_MESSAGE = "Fades shortened to fit the Story.";
export const MUSIC_TOO_SHORT_MESSAGE =
  "This music is too short to loop (under 1 s); it plays once.";

/** The mix is only said to clip above full scale (with room for float noise). */
const CLIP_THRESHOLD = 1 + 1e-9;

/** Rounded UP to one decimal, so a voice that is cut by a frame never reads `0.0 s`. */
export const voiceCutMessage = (seconds: number): string =>
  `Voice is cut by ${(Math.ceil(seconds * 10 - 1e-9) / 10).toFixed(1)} s.`;

/** Rounded UP to one decimal, so a mix that clips never reads `1.0`. */
export const clipMessage = (peakGain: number): string =>
  `The mix may clip (peak gain ${(Math.ceil(peakGain * 10 - 1e-9) / 10).toFixed(1)}).`;

/** One line shown next to a control; `retry` adds the Retry button of a bundled sound that could not be fetched. */
export type AudioNotice = {
  text: string;
  retry?: {id: BundledAudio; label: string};
};

export type SceneAudioNotices = {sfx: AudioNotice[]; voice: AudioNotice[]};

export type AudioFieldNotices = {
  music: AudioNotice[];
  scenes: ReadonlyMap<number, SceneAudioNotices>;
};

/** No warnings at all (also what the editor shows while a visual draft is pending). */
export const NO_AUDIO_NOTICES: AudioFieldNotices = {music: [], scenes: new Map()};

/**
 * The warnings of the plan, placed by field: `Audio not available: render
 * blocked.` on the field whose sound has no usable source, `Audio could not be
 * loaded.` (with Retry) on a bundled sound whose store state is `fetch-failed`,
 * `Voice is cut by X.X s.` on the scene's voice, and the Story-level ones
 * (fades, clipping, music too short to loop) on the music panel. A sound that is
 * only loading has no text (its timeline block says so). Text comes straight
 * from `plan.issues` and `plan.maxSimultaneousGain`; nothing is recomputed.
 */
export const audioFieldNotices = (
  view: EditorAudioPlanView,
  bundled: ReadonlyMap<BundledAudio, BundledAudioState>,
): AudioFieldNotices => {
  const {issues, maxSimultaneousGain} = view.plan;

  if (issues.length === 0 && maxSimultaneousGain <= CLIP_THRESHOLD) {
    return NO_AUDIO_NOTICES;
  }

  const music: AudioNotice[] = [];
  const scenes = new Map<number, SceneAudioNotices>();
  const place = (
    role: AudioRole,
    sceneIndex: number | null,
    notice: AudioNotice,
  ) => {
    if (role === "music" || sceneIndex === null) {
      music.push(notice);

      return;
    }

    const entry = scenes.get(sceneIndex) ?? {sfx: [], voice: []};

    entry[role].push(notice);
    scenes.set(sceneIndex, entry);
  };
  const failedBundled = (ref: AudioRef): BundledAudio | null =>
    isBundledAudio(ref) && bundled.get(ref)?.kind === "fetch-failed" ? ref : null;

  for (const issue of issues) {
    switch (issue.kind) {
      case "missing-audio":
        place(issue.role, issue.sceneIndex, {text: AUDIO_NOT_AVAILABLE_MESSAGE});
        break;
      case "pending-audio": {
        const id = failedBundled(issue.ref);

        if (id !== null) {
          place(issue.role, issue.sceneIndex, {
            text: AUDIO_NOT_LOADED_MESSAGE,
            retry: {id, label: bundledAudioCatalog[id].label},
          });
        }

        break;
      }
      case "voice-cut":
        place("voice", issue.sceneIndex, {text: voiceCutMessage(issue.seconds)});
        break;
      case "fades-scaled":
        music.push({text: FADES_SCALED_MESSAGE});
        break;
      case "music-too-short-to-loop":
        music.push({text: MUSIC_TOO_SHORT_MESSAGE});
        break;
      default:
        break;
    }
  }

  if (maxSimultaneousGain > CLIP_THRESHOLD) {
    music.push({text: clipMessage(maxSimultaneousGain)});
  }

  return {music, scenes};
};

export const NO_SCENE_NOTICES: SceneAudioNotices = {sfx: [], voice: []};
