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
  whoosh: {id: "whoosh", label: "Whoosh", kind: "sfx", file: null, durationSeconds: null},
  boom: {id: "boom", label: "Boom", kind: "sfx", file: null, durationSeconds: null},
  ding: {id: "ding", label: "Ding", kind: "sfx", file: null, durationSeconds: null},
  pop: {id: "pop", label: "Pop", kind: "sfx", file: null, durationSeconds: null},
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
    if (typeof seconds === "number") map[ref] = seconds;
  }
  return map;
};
