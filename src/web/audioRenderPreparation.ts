// The audio half of the browser render transaction's preparation (AUDIO-005):
// freezes the render's audio sources, re-checks the frozen map and preflights
// every audio source before OPFS is touched (AINV-8).
//
// It wraps the local-asset preparation (`createLocalAssetRenderPreparation`),
// which already verified, locked and leased the local audio payloads exactly
// like the images, and adds what only the audio needs: render-owned object URLs
// for the bundled sounds, the exact durations, and the preflight.

import {
  bundledAudioCatalog,
  isBundledAudio,
  type AudioDurationMap,
  type AudioRef,
  type BundledAudio,
} from "../audio/catalog.ts";
import {
  audioFileUnusableMessage,
  compileFrozenAudioPlan,
  storyTooLongWithVoicesMessage,
} from "../audio/readiness.ts";
import {buildAudioSourceMap, type AudioSource} from "../audio/sources.ts";
import {storyAudioDurations, storyAudioRefs} from "../audio/storyAudio.ts";
import {inspectAudio} from "../localAssets/audioInspection.ts";
import {isAudioPayload} from "../localAssets/readiness.ts";
import {isLocalAudioRef, type LocalAudioRef} from "../localAssets/refs.ts";
import {shortAssetId} from "../localAssets/sources.ts";
import {getStoryMetadata} from "../story/metadata.ts";
import type {Story} from "../story/types.ts";
import {VIDEO_FPS} from "../videoConfig.ts";
import type {AudioDecodeCache} from "./assetLibrary/audioDecodeCache.ts";
import type {AssetLibraryStore} from "./assetLibrary/store.ts";
import type {
  LocalAssetRenderPreparation,
  ResolvedStoryLocalAssetState,
} from "./localAssetState.ts";

/** Bundled durations are catalog constants; the blob must agree within this much (D-8). */
const BUNDLED_DURATION_TOLERANCE_SECONDS = 0.001;

export const AUDIO_CHANGED_MESSAGE =
  "Audio changed while preparing the render. Try again.";

/** Shown while the sources are inspected and decoded (up to one decode per distinct local file). */
export const CHECKING_AUDIO_MESSAGE = "Checking audio…";

/**
 * One entry of the bundled-audio store's snapshot as the render needs it
 * (AUDIO-004's `getBundledAudioStates()` values satisfy it): only a `ready`
 * entry carries the `blob` that the store inspected, fully decoded and
 * truncation-checked in this page session.
 */
export type BundledRenderState = {
  readonly kind: string;
  readonly blob?: Blob;
};

export type AudioRenderPreparationInput = {
  story: Story;
  /** The state the click verified; null when the Story has no local refs at all. */
  resolved: ResolvedStoryLocalAssetState | null;
  /** `createLocalAssetRenderPreparation(...)` for that state, or null when there is nothing local. */
  prepareLocal: ((signal: AbortSignal) => Promise<LocalAssetRenderPreparation>) | null;
  /** The store's snapshot at the moment of the call (frozen into the render here). */
  getBundledStates: () => ReadonlyMap<BundledAudio, BundledRenderState>;
  /** Names a local file in the preflight error; read only when a preflight fails. */
  store: AssetLibraryStore | null;
  decodeCache: AudioDecodeCache;
  /** Told once, before the first inspection or decode, so the page can say what the wait is. */
  onStatus?: (message: string) => void;
  deps?: {
    createObjectUrl?: (blob: Blob) => string;
    revokeObjectUrl?: (url: string) => void;
  };
};

/**
 * The step `startBrowserRenderTransaction` runs right after the render lock is
 * granted and before any OPFS work. Returns `{ok: false}` (outcome
 * `assets-changed`) when a source is no longer what the click saw, and rejects
 * (outcome `failure`) with `Audio file <label> cannot be used for rendering.`
 * when a source fails its preflight. Whatever it acquired is released on every
 * path that does not return `{ok: true}`.
 */
export const createAudioRenderPreparation =
  (input: AudioRenderPreparationInput) =>
  async (signal: AbortSignal): Promise<LocalAssetRenderPreparation> => {
    const {story, resolved, decodeCache} = input;
    const createObjectUrl =
      input.deps?.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
    const revokeObjectUrl =
      input.deps?.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));

    const local: LocalAssetRenderPreparation =
      input.prepareLocal === null
        ? {ok: true, localAssetSources: undefined, release: () => undefined}
        : await input.prepareLocal(signal);

    if (!local.ok) {
      return local;
    }

    const urls: string[] = [];
    let released = false;
    const release = () => {
      if (released) {
        return;
      }

      released = true;

      for (const url of urls) {
        revokeObjectUrl(url);
      }

      local.release();
    };
    const labelOf = async (ref: AudioRef): Promise<string> => {
      if (isBundledAudio(ref)) {
        return bundledAudioCatalog[ref].label;
      }

      try {
        const row = await input.store?.getAssetRow(ref);

        return row?.status === "present" ? row.value.label : shortAssetId(ref);
      } catch {
        return shortAssetId(ref);
      }
    };

    try {
      const refs = storyAudioRefs(story);
      const states = input.getBundledStates();
      const bundledBlobs = new Map<BundledAudio, Blob>();

      // 1. Each referenced bundled id must still be ready; its blob is the one
      // the store checked in this session (the renderer never re-fetches it).
      for (const ref of refs) {
        if (!isBundledAudio(ref)) {
          continue;
        }

        const state = states.get(ref);

        if (state?.kind !== "ready" || !(state.blob instanceof Blob)) {
          release();

          return {ok: false, message: AUDIO_CHANGED_MESSAGE};
        }

        bundledBlobs.set(ref, state.blob);
      }

      signal.throwIfAborted();

      // 2. The frozen map: lease-owned local URLs plus render-owned bundled URLs.
      const bundledSources = new Map<BundledAudio, AudioSource>();

      for (const [id, blob] of bundledBlobs) {
        const url = createObjectUrl(blob);

        urls.push(url);
        bundledSources.set(id, {kind: "url", url});
      }

      const audioSources = Object.freeze(
        buildAudioSourceMap(story, local.localAssetSources, (id) =>
          bundledSources.get(id),
        ),
      );

      // 3. The durations the render will use: the verified local metadata
      // (the very payloads whose bytes the sources point at) and the catalog.
      const localDurations: Partial<Record<LocalAudioRef, number>> = {};

      for (const ref of refs) {
        if (isLocalAudioRef(ref)) {
          const verified = resolved?.verified.get(ref.slice(ref.length - 64));

          if (verified !== undefined && isAudioPayload(verified)) {
            localDurations[ref] = verified.durationSeconds;
          }
        }
      }

      const audioDurations: AudioDurationMap = storyAudioDurations(
        story,
        localDurations,
      );

      // 4. Re-check the frozen map: not one source may be pending or missing
      // (for example a bundled id that turned unusable after the click).
      const plan = compileFrozenAudioPlan(story, audioDurations, audioSources);

      if (plan.issues.some((issue) => issue.kind === "story-too-long-for-audio")) {
        const frames = getStoryMetadata(story, VIDEO_FPS, audioDurations)
          .durationInFrames;

        release();

        return {
          ok: false,
          message: storyTooLongWithVoicesMessage(Math.ceil(frames / VIDEO_FPS)),
        };
      }

      if (
        plan.issues.some(
          (issue) =>
            issue.kind === "missing-audio" || issue.kind === "pending-audio",
        )
      ) {
        release();

        return {ok: false, message: AUDIO_CHANGED_MESSAGE};
      }

      // 5. Preflight, on the exact bytes the render will read (AINV-8).
      input.onStatus?.(CHECKING_AUDIO_MESSAGE);
      for (const [id, blob] of bundledBlobs) {
        signal.throwIfAborted();

        const inspected = await inspectAudio(blob);
        const expected = bundledAudioCatalog[id].durationSeconds;

        if (
          !inspected.ok ||
          expected === null ||
          Math.abs(inspected.metadata.durationSeconds - expected) >
            BUNDLED_DURATION_TOLERANCE_SECONDS
        ) {
          throw new Error(audioFileUnusableMessage(await labelOf(id)));
        }
        // Its full decode is the store's: `ready` means inspected, decoded and
        // truncation-checked for exactly this Blob.
      }

      for (const ref of refs) {
        if (!isLocalAudioRef(ref)) {
          continue;
        }

        signal.throwIfAborted();

        const digest = ref.slice(ref.length - 64);
        const verified = resolved?.verified.get(digest);
        const blob = resolved?.blobs.get(digest);

        if (verified === undefined || blob === undefined || !isAudioPayload(verified)) {
          throw new Error(audioFileUnusableMessage(await labelOf(ref)));
        }

        // The local integrity check already compared the container metadata;
        // a decode in THIS page session is what proves the renderer will not stall.
        const decoded = await decodeCache.verify(digest, blob, verified, {signal});

        if (!decoded.ok) {
          throw new Error(audioFileUnusableMessage(await labelOf(ref)));
        }
      }

      signal.throwIfAborted();

      return {
        ok: true,
        localAssetSources: local.localAssetSources,
        audioSources,
        localAudioDurations: Object.freeze({...localDurations}),
        release,
      };
    } catch (error) {
      release();

      throw error;
    }
  };
