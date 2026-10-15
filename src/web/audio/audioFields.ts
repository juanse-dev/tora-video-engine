import {
  bundledAudioCatalog,
  isBundledAudio,
  type AudioDurationMap,
  type AudioRef,
  type BundledAudio,
  type BundledAudioEntry,
} from "../../audio/catalog.ts";
import {
  DEFAULT_AUDIO_VOLUME,
  DEFAULT_MUSIC_DUCK,
} from "../../audio/constants.ts";
import type {LocalAudioRef} from "../../localAssets/refs.ts";
import {formatAudioDuration} from "../../audio/formatDuration.ts";
import {shortAssetId} from "../../localAssets/sources.ts";
import type {AudioClip, Music} from "../../story/schema.ts";
import {sceneFrames} from "../../story/timeline.ts";
import {
  setVisualMusic,
  type VisualSceneDraft,
  type VisualStoryDraft,
} from "../visualDraft.ts";

/** The value of the `None` option of every sound select. */
export const NO_AUDIO_VALUE = "";

export type SceneAudioRole = "sfx" | "voice";

/** The defaults the Story omits (canonical YAML stays minimal). */
export const MUSIC_DEFAULTS = {
  volume: DEFAULT_AUDIO_VOLUME,
  duck: DEFAULT_MUSIC_DUCK,
  fadeIn: 0,
  fadeOut: 0,
} as const;

export type MusicNumberField = keyof typeof MUSIC_DEFAULTS;

/**
 * A My audio row as a select option: the label the user gave it. The duration
 * is only read for rows whose label another row shares (to tell them apart).
 */
export type LibraryAudioOption = {
  ref: LocalAudioRef;
  label: string;
  durationSeconds?: number;
};

/** The My audio rows for the selects, and whether the read that produced them has settled. */
export type LibraryAudioChoices = {
  rows: readonly LibraryAudioOption[];
  settled: boolean;
};

export type AudioSelectOption = {value: string; label: string};

export type AudioSelectGroups = {
  /** Catalog entries with a file, music first. */
  bundled: AudioSelectOption[];
  /** Library rows by label. */
  library: AudioSelectOption[];
  /** The Story's own value when neither group offers it (a missing local file, a bundled id without a file). */
  current: AudioSelectOption | null;
};

/** One collator for every sort: case-insensitive, accents distinct (building one per comparison is slow). */
const labelCollator = new Intl.Collator("en", {sensitivity: "accent"});

const compareLibraryAudio = (a: LibraryAudioOption, b: LibraryAudioOption): number =>
  labelCollator.compare(a.label, b.label) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);

/**
 * The text of every library row. Labels are not unique (a different file with
 * the same name imports under the same default label), so rows that share a
 * label get ` (m:ss)` appended, and rows still equal after that a short id
 * ` · abcd…1234`. Rows with a unique label are shown as they are.
 */
const libraryOptionTexts = (rows: readonly LibraryAudioOption[]): string[] => {
  const count = (values: readonly string[]) => {
    const counts = new Map<string, number>();

    for (const value of values) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }

    return counts;
  };
  const labelCounts = count(rows.map((row) => row.label));
  const withDuration = rows.map((row) =>
    (labelCounts.get(row.label) ?? 0) > 1 && row.durationSeconds !== undefined
      ? `${row.label} (${formatAudioDuration(row.durationSeconds)})`
      : row.label,
  );
  const textCounts = count(withDuration);

  return rows.map((row, index) =>
    (labelCounts.get(row.label) ?? 0) > 1 && (textCounts.get(withDuration[index]) ?? 0) > 1
      ? `${withDuration[index]} · ${shortAssetId(row.ref)}`
      : withDuration[index],
  );
};

/** Shown for a held local ref until the library read has settled: it may well be in the library. */
export const LOADING_AUDIO_LABEL = "Loading audio…";

const unavailableLabel = (value: string, librarySettled: boolean): string =>
  isBundledAudio(value)
    ? `${bundledAudioCatalog[value].label} (not available)`
    : librarySettled
      ? `Missing audio ${shortAssetId(value as LocalAudioRef)}`
      : LOADING_AUDIO_LABEL;

/**
 * The options of one sound select. Bundled entries with `file: null` are
 * absent (they cannot play); the group lists music before effects, otherwise in
 * catalog order. Library rows are sorted by label (case-insensitive, accents
 * distinct), then by ref, and rows that share a label are told apart (see
 * `libraryOptionTexts`). A value the
 * Story already holds that is in neither group stays selectable, so the select
 * never shows a different sound than the Story has (AINV-5); a local ref reads
 * `Loading audio…` (not `Missing audio …`) until the library read has settled.
 */
export const audioSelectOptions = (input: {
  current: string | undefined;
  library: readonly LibraryAudioOption[];
  /** False while the library read has not settled (default true). */
  librarySettled?: boolean;
  catalog?: Readonly<Record<BundledAudio, BundledAudioEntry>>;
}): AudioSelectGroups => {
  const entries = Object.values(input.catalog ?? bundledAudioCatalog).filter(
    (entry) => entry.file !== null,
  );
  const bundled = [
    ...entries.filter((entry) => entry.kind === "music"),
    ...entries.filter((entry) => entry.kind !== "music"),
  ].map((entry) => ({value: entry.id as string, label: entry.label}));
  const sorted = [...input.library].sort(compareLibraryAudio);
  const texts = libraryOptionTexts(sorted);
  const library = sorted.map((row, index) => ({
    value: row.ref as string,
    label: texts[index],
  }));
  const offered = new Set([...bundled, ...library].map((option) => option.value));
  const current =
    input.current === undefined || offered.has(input.current)
      ? null
      : {
          value: input.current,
          label: unavailableLabel(input.current, input.librarySettled ?? true),
        };

  return {bundled, library, current};
};

const withoutKey = <T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> => {
  const copy = {...value};

  delete copy[key];

  return copy;
};

/** Selects (or, with `null`, removes) the Story's music; the other music settings are kept. */
export const setDraftMusicSource = (
  draft: VisualStoryDraft,
  src: AudioRef | null,
): VisualStoryDraft =>
  setVisualMusic(
    draft,
    src === null ? undefined : ({...(draft.music ?? {}), src} as Music),
  );

/** Writes one music number; a value equal to its default is omitted. No music: unchanged. */
export const setDraftMusicNumber = (
  draft: VisualStoryDraft,
  field: MusicNumberField,
  value: number,
): VisualStoryDraft => {
  if (draft.music === undefined) {
    return draft;
  }

  return setVisualMusic(
    draft,
    value === MUSIC_DEFAULTS[field]
      ? (withoutKey(draft.music, field) as Music)
      : {...draft.music, [field]: value},
  );
};

/** Selects (or removes) a scene's sound effect; its volume is kept. */
export const setSceneSfxSource = (
  scene: VisualSceneDraft,
  src: AudioRef | null,
): VisualSceneDraft =>
  src === null
    ? (withoutKey(scene, "sfx") as VisualSceneDraft)
    : {...scene, sfx: {...(scene.sfx ?? {}), src} as AudioClip};

/** Writes the volume of a scene's sfx or voice; the default is omitted. No clip: unchanged. */
export const setSceneAudioVolume = (
  scene: VisualSceneDraft,
  role: SceneAudioRole,
  volume: number,
): VisualSceneDraft => {
  const clip = scene[role];

  if (clip === undefined) {
    return scene;
  }

  return {
    ...scene,
    [role]:
      volume === DEFAULT_AUDIO_VOLUME
        ? withoutKey(clip, "volume")
        : {...clip, volume},
  };
};

const isAuto = (scene: VisualSceneDraft): boolean =>
  scene.duration.trim() === "auto";

/** The remembered numeric duration, when it is still a usable one. */
const rememberedDuration = (scene: VisualSceneDraft): string | null => {
  const seconds = Number(scene.lastDuration);

  return scene.lastDuration !== undefined &&
    scene.lastDuration.trim() !== "" &&
    Number.isFinite(seconds) &&
    seconds > 0
    ? scene.lastDuration
    : null;
};

/** Seconds rounded to 0.1 s, as the text of a duration input. */
export const roundedSeconds = (seconds: number): string =>
  String(Math.max(0.1, Math.round(seconds * 10) / 10));

/** The duration a scene gets back when it stops being `auto`. */
const restoredDuration = (
  scene: VisualSceneDraft,
  resolvedSeconds: number,
): string => rememberedDuration(scene) ?? roundedSeconds(resolvedSeconds);

const withoutAutoMemory = (scene: VisualSceneDraft): VisualSceneDraft =>
  withoutKey(scene, "lastDuration") as VisualSceneDraft;

/**
 * Checks or unchecks `Auto (from voice)`. Checking needs a voice and remembers
 * the numeric duration; unchecking restores it (or `resolvedSeconds` rounded to
 * 0.1 s when none was remembered, for example a Story read from YAML).
 */
export const setSceneAuto = (
  scene: VisualSceneDraft,
  auto: boolean,
  resolvedSeconds: number,
): VisualSceneDraft => {
  if (auto) {
    return scene.voice === undefined || isAuto(scene)
      ? scene
      : {...scene, duration: "auto", lastDuration: scene.duration};
  }

  return isAuto(scene)
    ? {
        ...withoutAutoMemory(scene),
        duration: restoredDuration(scene, resolvedSeconds),
      }
    : scene;
};

/**
 * Selects, replaces or (with `null`) removes a scene's voice. Removing the
 * voice of an `auto` scene is ONE edit: the same candidate also gives the scene
 * its numeric duration back, so it validates and no pending draft appears.
 */
export const setSceneVoiceSource = (
  scene: VisualSceneDraft,
  src: AudioRef | null,
  resolvedSeconds: number,
): VisualSceneDraft => {
  if (src !== null) {
    return {...scene, voice: {...(scene.voice ?? {}), src} as AudioClip};
  }

  const withoutVoice = withoutKey(scene, "voice") as VisualSceneDraft;

  return isAuto(scene)
    ? {
        ...withoutAutoMemory(withoutVoice),
        duration: restoredDuration(scene, resolvedSeconds),
      }
    : withoutVoice;
};

export type AutoSceneView = {
  seconds: number;
  source: "voice" | "fallback";
};

/**
 * What an `auto` scene resolves to, through the very rule `compileTimeline`
 * uses (`sceneFrames`), so the text can never disagree with the Player.
 */
export const autoSceneView = (
  scene: Pick<VisualSceneDraft, "voice">,
  audioDurations: AudioDurationMap,
  fps: number,
): AutoSceneView => {
  const {durationInFrames, durationSource} = sceneFrames(
    {duration: "auto", voice: scene.voice},
    fps,
    audioDurations,
  );

  return {
    seconds: durationInFrames / fps,
    source: durationSource === "voice" ? "voice" : "fallback",
  };
};

/** `auto · 4.3 s`, or `auto · voice not available` for a scene on the fallback length. */
export const autoDurationText = (view: AutoSceneView): string =>
  view.source === "voice"
    ? `auto · ${view.seconds.toFixed(1)} s`
    : "auto · voice not available";
