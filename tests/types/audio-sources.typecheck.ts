// Compiled by `tsc` (npm run lint); never executed.
import type {AudioSourceMap} from "../../src/audio/sources.ts";
import {buildAudioSourceMap} from "../../src/audio/sources.ts";
import type {LocalAudioRef, LocalPoseRef} from "../../src/localAssets/refs.ts";
import type {LocalAssetSourceMap} from "../../src/localAssets/sources.ts";
import type {Story} from "../../src/story/types.ts";
import type {ToraVideoProps} from "../../src/Video.tsx";

// The Player marks a failed bundled sound as unavailable.
export const playerSources: AudioSourceMap = {ding: {kind: "unavailable"}};

// The CLI stages bundled files and hands out static paths.
export const cliSources: AudioSourceMap = {
  ding: {kind: "static", path: "__local-assets/ding.wav"},
  pop: {kind: "url", url: "blob:http://localhost/pop"},
  boom: {kind: "pending"},
};

// The image source contract does not accept `unavailable`.
export const imageEntry: NonNullable<LocalAssetSourceMap[LocalPoseRef]> =
  // @ts-expect-error `unavailable` is an audio-only state
  {kind: "unavailable"};

// An audio source map is keyed by audio refs only.
declare const poseRef: LocalPoseRef;
declare const audioRef: LocalAudioRef;

export const audioKey: keyof AudioSourceMap = audioRef;
// @ts-expect-error an image ref is not an audio key
export const imageKey: keyof AudioSourceMap = poseRef;

// The image source map every caller already owns is accepted as the local input.
declare const story: Story;
declare const imageMap: LocalAssetSourceMap;

export const fromImageMap = buildAudioSourceMap(story, imageMap, () => undefined);
export const fromNothing = buildAudioSourceMap(story, undefined, () => ({
  kind: "unavailable",
}));

// The composition accepts the audio props (Player, renderers and Studio).
export const compositionProps: ToraVideoProps = {
  story,
  audioSources: playerSources,
  bundledAudioPolicy: "explicit",
  audioArmed: false,
};
export const studioProps: ToraVideoProps = {story};
export const badPolicy: ToraVideoProps = {
  story,
  // @ts-expect-error only "explicit" and "static-fallback" exist
  bundledAudioPolicy: "always",
};
