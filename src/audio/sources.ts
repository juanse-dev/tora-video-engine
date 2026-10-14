import {staticFile} from "remotion";
import type {LocalAudioRef} from "../localAssets/refs.ts";
import type {LocalAssetSource} from "../localAssets/sources.ts";
import type {Story} from "../story/types.ts";
import {
  bundledAudioCatalog,
  isBundledAudio,
  type AudioRef,
  type BundledAudio,
} from "./catalog.ts";
import {storyAudioRefs} from "./storyAudio.ts";

/**
 * Where an audio ref's bytes can be loaded from (runtime only, never
 * persisted). `unavailable` is the terminal state of a ref that cannot be
 * played; the image `LocalAssetSource` has no such state and stays unchanged.
 */
export type AudioSource = LocalAssetSource | {kind: "unavailable"};

export type AudioSourceMap = Readonly<
  Partial<Record<LocalAudioRef | BundledAudio, AudioSource>>
>;

/** What a producer of local sources hands to `buildAudioSourceMap`. */
export type LocalAudioSourceMap = Readonly<
  Partial<Record<LocalAudioRef, LocalAssetSource>>
>;

/** "explicit": a bundled id without an entry is pending. "static-fallback": it resolves to staticFile(entry.file). */
export type BundledAudioPolicy = "explicit" | "static-fallback";

export type AudioSourceResolution =
  | {kind: "audio"; src: string}
  | {kind: "pending"; ref: AudioRef}
  | {kind: "missing"; ref: AudioRef};

const entryFor = (
  sources: AudioSourceMap | undefined,
  ref: AudioRef,
): AudioSource | undefined =>
  sources !== undefined && Object.prototype.hasOwnProperty.call(sources, ref)
    ? sources[ref]
    : undefined;

/**
 * Pure resolution of an audio ref to something playable. Never falls back to
 * another sound (AINV-5): a ref without a usable source is pending or missing.
 */
export const resolveAudioSrc = (
  ref: AudioRef,
  sources: AudioSourceMap | undefined,
  policy: BundledAudioPolicy,
): AudioSourceResolution => {
  const entry = entryFor(sources, ref);

  if (entry !== undefined) {
    switch (entry.kind) {
      case "url":
        return {kind: "audio", src: entry.url};
      case "static":
        return {kind: "audio", src: staticFile(entry.path)};
      case "pending":
        return {kind: "pending", ref};
      case "unavailable":
        return {kind: "missing", ref};
      default:
        // A malformed entry never falls through to the bundled fallback.
        return {kind: "missing", ref};
    }
  }

  if (!isBundledAudio(ref)) {
    return {kind: "missing", ref};
  }

  if (policy === "explicit") {
    return {kind: "pending", ref};
  }

  const {file} = bundledAudioCatalog[ref];

  return file === null
    ? {kind: "missing", ref}
    : {kind: "audio", src: staticFile(file)};
};

/**
 * Assembles the `audioSources` prop of a Story from the sources each producer
 * already owns: a `local:audio:` ref copies the same entry object from
 * `localSources` (no new object URL, no revocation: ownership, leases and
 * `pending` stay with the producer); a bundled id takes `bundled(id)`. Refs the
 * Story does not use are never included and a ref without an entry is absent.
 */
export const buildAudioSourceMap = (
  story: Story,
  localSources: LocalAudioSourceMap | undefined,
  bundled: (id: BundledAudio) => AudioSource | undefined,
): AudioSourceMap => {
  const map: Partial<Record<LocalAudioRef | BundledAudio, AudioSource>> = {};

  for (const ref of storyAudioRefs(story)) {
    const entry = isBundledAudio(ref)
      ? bundled(ref)
      : localSources !== undefined &&
          Object.prototype.hasOwnProperty.call(localSources, ref)
        ? localSources[ref]
        : undefined;

    if (entry !== undefined) {
      map[ref] = entry;
    }
  }

  return map;
};

/** Maps a resolution to the `sourceState` that `compileAudioPlan` expects. */
export const audioSourceState = (
  resolution: AudioSourceResolution,
): "ready" | "pending" | "missing" =>
  resolution.kind === "audio" ? "ready" : resolution.kind;
