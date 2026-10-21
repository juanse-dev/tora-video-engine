import {isLocalAudioRef, type LocalAudioRef} from "../localAssets/refs.ts";

export const bundledAudioIds = ["whoosh", "boom", "ding", "pop", "calm-loop", "upbeat-loop"] as const;
export type BundledAudio = (typeof bundledAudioIds)[number];
export type AudioRef = BundledAudio | LocalAudioRef;
export type AudioDurationMap = Readonly<Partial<Record<AudioRef, number>>>;

export type BundledAudioEntry = {
  id: BundledAudio;
  label: string;
  kind: "sfx" | "music";
  file: string | null;
  durationSeconds: number | null;
};

export const bundledAudioCatalog: Readonly<Record<BundledAudio, BundledAudioEntry>> = {
  whoosh: {id: "whoosh", label: "Whoosh", kind: "sfx", file: "audio/sfx/whoosh.wav", durationSeconds: 0.42},
  boom: {id: "boom", label: "Boom", kind: "sfx", file: "audio/sfx/boom.wav", durationSeconds: 3.2},
  ding: {id: "ding", label: "Ding", kind: "sfx", file: "audio/sfx/ding.wav", durationSeconds: 1.8},
  pop: {id: "pop", label: "Pop", kind: "sfx", file: "audio/sfx/pop.wav", durationSeconds: 0.25},
  "calm-loop": {id: "calm-loop", label: "Calm loop", kind: "music", file: null, durationSeconds: null},
  "upbeat-loop": {id: "upbeat-loop", label: "Upbeat loop", kind: "music", file: null, durationSeconds: null},
};

export const isBundledAudio = (value: string): value is BundledAudio =>
  (bundledAudioIds as readonly string[]).includes(value);

export const isAudioRef = (value: string): value is AudioRef =>
  isBundledAudio(value) || isLocalAudioRef(value);

export const buildAudioDurationMap = (
  refs: Iterable<AudioRef>,
  localDurations: AudioDurationMap,
): AudioDurationMap => {
  const map: Partial<Record<AudioRef, number>> = {};
  for (const ref of refs) {
    const seconds = isBundledAudio(ref)
      ? bundledAudioCatalog[ref].durationSeconds
      : localDurations[ref];
    // AINV-2 / compileTimeline: a NaN, infinite or non-positive duration would make
    // the timeline throw inside the Player, so it never enters the map.
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
      map[ref] = seconds;
    }
  }
  return map;
};
