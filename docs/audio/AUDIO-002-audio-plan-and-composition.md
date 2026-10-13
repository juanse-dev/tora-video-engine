# AUDIO-002 — Audio plan, composition and Player audio

Status: not started

Depends on: AUDIO-001. Read [README](./README.md) first.

## Goal

One pure function, `compileAudioPlan`, decides every sound in the video: where it starts, how long it plays and its gain on every frame (AINV-4). A thin React component turns the plan into `@remotion/media` `<Audio>` elements inside `<Sequence>`s, so the Player, the browser render and the CLI all play the same mix. The Player gets volume controls and starts muted (D-12).

## Plan semantics

All times below are in frames at the composition FPS; seconds are converted with `Math.round(seconds * fps)` unless stated. `T` = `timeline.durationInFrames`.

- **Track sources.** The caller gives the planner each ref's source state, `sourceState(ref): "ready" | "pending" | "missing"` (from `resolveAudioSrc`: `audio` → ready, `pending` → pending, `missing` → missing). A track is emitted only when the state is `ready` **and** the ref's duration is in `audioDurations`. Otherwise nothing is emitted for it and the plan records exactly one issue: `missing` → `{kind: "missing-audio", ref, role, sceneIndex}`; `pending`, or `ready` without a duration yet (metadata still loading) → `{kind: "pending-audio", ref, role, sceneIndex}`. Both issues block MP4 render (AINV-5, AUDIO-005); only `missing-audio` is shown as an error in the editor, `pending-audio` is a loading state.
- **Music.** Let `D = max(1, round(musicSeconds * fps))`. If `D >= T`, one copy `[0, T)`. If `musicSeconds < MIN_LOOPING_MUSIC_SECONDS`, one copy `[0, min(D, T))` (no loop) and the plan records `{kind: "music-too-short-to-loop"}`. Otherwise let `X = min(round(MUSIC_CROSSFADE_SECONDS * fps), floor(D / 2))`, so the stride `S = D - X >= ceil(D / 2) >= 1` is always positive and copies cannot pile up; copies start at `k * S` for `k = 0, 1, …` while the start is `< T`; copy `k` lasts `min(D, T - start)`. In each overlap of `X` frames, with `u = (f − overlapStart + 0.5) / X`, the outgoing copy's crossfade factor is `cos(πu/2)` and the incoming one's `sin(πu/2)` (equal-power, D-4); with `X = 0` copies abut. No `<Audio loop>` (D-4). Copy count is bounded everywhere, not only in the browser: a Story with audio longer than `MAX_AUDIO_STORY_SECONDS` (3,600 s) gets the plan issue `{kind: "story-too-long-for-audio"}` and **no tracks** (render is blocked in both renderers, AUDIO-005), so with `MIN_LOOPING_MUSIC_SECONDS = 1` a plan has at most `ceil(108_000 / 21) = 5_143` music copies (429 under the browser's 9,000-frame cap), and `<Sequence>` mounts only the ones overlapping the current frame.
- **Music envelope.** `gain(f) = volume × fade(f) × duckGain(f) × crossfade(f)`, where `fade` is a linear ramp over `fadeIn` from frame 0 and over `fadeOut` to frame `T`; if `fadeIn + fadeOut > T / fps`, both are scaled by `(T / fps) / (fadeIn + fadeOut)` and the plan records `{kind: "fades-scaled"}` (D-5).
- **Minimum length.** Every audio length in frames is `max(1, round(seconds * fps))` before any clamp, so a valid sub-frame file (AINV-7 only requires `> 0`, e.g. a 5 ms click) still yields a track of at least 1 frame; the clamps below never go under 1 because a scene and the remaining Story are at least 1 frame long. `auto` already rounds up (AUDIO-001).
- **Sfx.** Starts at its scene's `from`; lasts `min(max(1, round(sfxSeconds * fps)), T - from)` frames; constant gain `volume` (default 1).
- **Voice.** Starts at its scene's `from`; lasts `min(max(1, round(voiceSeconds * fps)), scene.durationInFrames)`; constant gain `volume`. If the voice is longer than a **fixed** scene, the plan records `{kind: "voice-cut", sceneIndex, seconds}` with the cut length in seconds (D-3).
- **Ducking windows** (D-6). Collect `[start, end)` of every emitted sfx and voice track; sort; merge windows whose gap is `< round(DUCK_MERGE_GAP_SECONDS * fps)` frames. With `R = round(DUCK_RAMP_SECONDS * fps)`, `duckGain` is 1 outside windows, `duck` inside, a linear ramp 1→`duck` over `[start - R, start)` and `duck`→1 over `[end, end + R)`, clamped to `[0, T)`. Overlapping ramps take the minimum gain. With `duck = 1` or no windows, `duckGain ≡ 1`.
- **Clipping hint** (D-7). `maxSimultaneousGain` = the maximum over frames of the **amplitude** sum of every mounted track's `gainAt`, including both music copies inside a crossfade (`cos + sin` peaks at √2 at the overlap centre). This is the conservative bound: correlated, in-phase loop material really can reach it, so a full-volume looping music track warns `may clip` at its seams, which is correct. Computed analytically over the plan's breakpoints, not by iterating every frame of a 9,000-frame Story more than once.

## Interfaces

### `src/audio/plan.ts`

```ts
export type AudioRole = "music" | "sfx" | "voice";
export type AudioPlanTrack = {
  key: string;                       // stable: "music-0", "music-1", "sfx-3", "voice-3"
  role: AudioRole;
  ref: AudioRef;
  sceneIndex: number | null;         // null for music
  fromFrame: number;                 // absolute composition frame
  durationInFrames: number;          // >= 1
  gainAt: (absoluteFrame: number) => number; // in [0, 1]; pure; defined for [fromFrame, fromFrame + durationInFrames)
};
export type AudioPlanIssue =
  | {kind: "missing-audio"; ref: AudioRef; role: AudioRole; sceneIndex: number | null}
  | {kind: "pending-audio"; ref: AudioRef; role: AudioRole; sceneIndex: number | null}
  | {kind: "voice-cut"; sceneIndex: number; seconds: number}
  | {kind: "fades-scaled"}
  | {kind: "music-too-short-to-loop"}
  | {kind: "story-too-long-for-audio"};
export type AudioPlan = {
  tracks: readonly AudioPlanTrack[];
  issues: readonly AudioPlanIssue[];
  maxSimultaneousGain: number;
  /** The music's single-source envelope `volume × fade × duckGain` (no crossfade factors), for display; null without music. */
  musicEnvelopeAt: ((absoluteFrame: number) => number) | null;
};
export const compileAudioPlan: (input: {
  story: Story;
  timeline: Timeline;
  fps: number;
  audioDurations: AudioDurationMap;
  sourceState: (ref: AudioRef) => "ready" | "pending" | "missing";
}) => AudioPlan;
```

A Story without audio yields `{tracks: [], issues: [], maxSimultaneousGain: 0, musicEnvelopeAt: null}`. Each music copy's `gainAt` is `musicEnvelopeAt(f) × crossfade(f)`, so the envelope is computed once, in the plan.

### `src/audio/sources.ts`

One audio source contract, separate from the image one. `LocalAssetSource` and `LocalAssetSourceMap` (`src/localAssets/sources.ts`) stay exactly as in v0.3, so the visual resolvers keep accepting only `url | static | pending`.

```ts
export type AudioSource = LocalAssetSource | {kind: "unavailable"};
export type AudioSourceMap = Readonly<Partial<Record<LocalAssetRef | BundledAudio, AudioSource>>>;
/** "explicit": a bundled id without an entry is pending. "static-fallback": it resolves to staticFile(entry.file). */
export type BundledAudioPolicy = "explicit" | "static-fallback";
export type AudioSourceResolution =
  | {kind: "audio"; src: string}
  | {kind: "pending"; ref: AudioRef}
  | {kind: "missing"; ref: AudioRef};
export const resolveAudioSrc: (ref: AudioRef, sources: AudioSourceMap | undefined, policy: BundledAudioPolicy) => AudioSourceResolution;
```

Resolution, for both kinds of ref: an entry `url` → `src = url`; `static` → `staticFile(path)`; `pending` → pending; `unavailable` → missing. With no entry: a local ref is missing; a bundled id is **pending** under `"explicit"`, and under `"static-fallback"` is `staticFile(entry.file)` when `file` is non-null, else missing. Never falls back to another sound (AINV-5).

Who uses which policy, so that no unverified bundled file is ever mounted by a product path:

- **Player** (`Preview`): `"explicit"`. Its map gets one entry per bundled id the Story references, from AUDIO-004's bundled-audio check: `pending` while the check runs or after a transient fetch error, `{kind: "url", url}` (an object URL of the very Blob that passed inspect + decode + truncation rule) on success, `unavailable` on a terminal failure. Until AUDIO-004 lands, the AUDIO-002 Player uses `"static-fallback"` (an interim, unreleased state; AUDIO-004 task 3 switches it and removes the fallback from the Player).
- **Browser render** (AUDIO-005): `"explicit"`, with an object URL of the preflighted bytes for every bundled id.
- **CLI** (AUDIO-005): `"explicit"`, with the staged copy (`static`) for every bundled id.
- **Remotion Studio** (`npm run dev`, default props only): `"static-fallback"`.

Transport: `ToraVideoProps` gains `audioSources?: AudioSourceMap` and `bundledAudioPolicy?: BundledAudioPolicy` (default `"static-fallback"`, used only by Studio); the image `localAssetSources` prop is unchanged. A new `AudioSourcesProvider` (`src/components/audioSources.tsx`) carries `{sources, policy}` to `StoryAudio`; the image `LocalAssetSourcesProvider` is untouched. `sourceState` (for `compileAudioPlan`) maps `resolveAudioSrc(ref, sources, policy).kind` as above, so pending and unavailable refs get no track (`pending-audio` and `missing-audio` respectively) while the other tracks still play.

### `src/components/StoryAudio.tsx`

Renders, for each plan track, `<Sequence from={track.fromFrame} durationInFrames={track.durationInFrames} layout="none"><Audio src={…} volume={(f) => track.gainAt(track.fromFrame + f)} /></Sequence>`, with `Audio` from `@remotion/media`. `isAvailable` is `resolveAudioSrc(...).kind === "audio"`. Mounted in `ToraVideo` next to `StoryRenderer` (inside `LocalAssetSourcesProvider`), and given the **same** timeline object `ToraVideo` compiled for `StoryRenderer` (AUDIO-001, one timeline per composition). Renders nothing for a Story without audio.

### Player (`src/web/components/Preview.tsx`)

`initiallyMuted` stays unconditional, exactly as in v0.3; `showVolumeControls` is `storyHasAudio(story)`, so a silent Story keeps v0.3's `showVolumeControls={false}` (AINV-6). `initiallyMuted` only affects the Player's first mount and `Preview` does not remount the Player on Story edits, so `Preview` gates the tracks instead of muting after the fact. `ToraVideoProps` gains `audioArmed?: boolean`, and `StoryAudio` renders **no** `<Audio>` only when it is **exactly `false`**; absent means armed, so Remotion Studio (`src/Root.tsx` default props, no `Preview`) and any composition rendered without a Player play audio. Only `Preview` ever passes `false`, from its first render until the handshake below. `Preview` keeps `armed` state: whenever `storyHasAudio(story)` is false, `armed` is false; when it is true and `armed` is false, a `useLayoutEffect` calls `playerRef.current.mute()` and only then sets `armed = true`, so the first commit containing `<Audio>` happens after the Player is muted (layout effects and their state updates complete before paint, and the tracks did not exist before). This one rule covers an edit, a YAML import, a stored-project restore and a reload (initial mount starts unarmed too), and asynchronous availability changes, since local tracks only appear while armed. No remount: the current frame and play state are kept. The render paths (`renderMediaOnWeb`, CLI) pass `audioArmed: true` explicitly. The audio → no-audio transition changes nothing but hiding the controls. `audioDurations` is always passed in `inputProps`. The Player's **outer** length must use the same map: `getWebPlayerConfig(story, audioDurations)` (`src/web/previewConfig.ts`) calls `getStoryMetadata(story, VIDEO_FPS, audioDurations)`, and `Preview` passes the exact map object it puts in `inputProps`, so the Player's `durationInFrames`, the inner timeline and `compileAudioPlan` can never disagree (otherwise a 2.2 s voice would play inside a Player still sized for the 3 s fallback, and a voice longer than 3 s would be cut by the Player). When an asset's availability changes, the map, the Player length and the plan change together in the same render. The Player's volume is stored in `localStorage` key `tora.playerVolume` (number in `[0, 1]`) inside try/catch and restored via the Player ref on mount; mute state is never restored as unmuted (D-12). The comment saying Stories are video-only is updated.

## Tasks

1. [ ] Add `@remotion/media@4.0.529` and `mediabunny@1.56.1` (exact) as dependencies.
2. [ ] `compileAudioPlan` with every rule above, plus `tests/audio-plan.test.mjs`.
3. [ ] `AudioSource`/`AudioSourceMap`/`BundledAudioPolicy`, `resolveAudioSrc`, `AudioSourcesProvider`, `StoryAudio` + `ToraVideo` wiring.
4. [ ] Player: muted start and volume controls only for Stories with audio, remembered volume, `audioDurations` in `inputProps`; the preview's `audioDurations` come from `storyAudioDurations(story, localDurations)` (AUDIO-001) where `localDurations` is empty until AUDIO-003 provides library metadata (bundled audio already works).

## Tests

- `tests/audio-plan.test.mjs` (fixture durations: music 10 s, voice 2.2 s, sfx 0.4 s, 30 FPS):
  - no audio → empty plan;
  - music shorter than the Story → copies at `k × (300 − 9)` frames (`X = round(0.3 × 30) = 9`), last copy truncated at `T`; at every overlap frame the two crossfade factors satisfy `out² + in² = 1` (±1e-9) and are monotonic;
  - **phase sanity (documents D-4):** summing two unit sinusoids with the plan's factors at the overlap centre gives amplitude `√2·cos(φ/2)` — ≈ 1.41 at `φ = 0°`, ≈ 0.71 at 120°, 0 at 180° (the linear law would give `cos(φ/2)`: 1, 0.5, 0) — while for two independent seeded noise signals the RMS stays within ±10% of 1 across the overlap. This is why AUDIO-006 checks the seam with noise, not a tone;
  - music longer than the Story → one copy;
  - music shorter than `MIN_LOOPING_MUSIC_SECONDS` (the 0.12 s `pop`) → one copy, no loop, `music-too-short-to-loop` issue, the function terminates;
  - a Story longer than 3,600 s with music → no tracks, one `story-too-long-for-audio` issue, and the function returns without building copies (property: a plan never holds more than 5,143 music copies + 2 tracks per scene);
  - music of 1.0 s at 30 FPS → `X = min(9, 15) = 9`, stride 21; music of 0.5 s is below the minimum; a duration where `floor(D / 2) < round(0.3 × fps)` clamps `X` and every stride is `>= 1`;
  - fade-in/out values at their endpoints and midpoints; fades scaled + issue when too long;
  - sfx crossing into the next scene keeps playing; sfx past the Story end is truncated;
  - voice cut + `voice-cut` issue with the right seconds; no issue for `auto` scenes;
  - ducking: single window ramps (gain exactly `duck` inside, 1 outside, ramp ends at window start), two windows 0.2 s apart merge, 0.5 s apart do not, `duck: 1` → 1 everywhere, default 0.35;
  - missing duration or unavailable source → no track + `missing-audio` issue with role and scene;
  - `maxSimultaneousGain` for overlapping sfx + voice + ducked music; for a music-only Story at `volume: 1` that loops it is `√2` (±1e-9, at the crossfade centre), and 1 when the music does not loop;
  - track keys are stable across calls;
  - sub-frame sources: a 0.005 s sfx and a 0.005 s voice (fixed and `auto` scenes) give tracks of exactly 1 frame, ducking windows of 1 frame plus ramps, and no track ever has `durationInFrames < 1` (property check over random durations in `(0, 0.05]` s).
- `tests/audio-sources.test.mjs`: every entry kind × {local, bundled} × both policies (bundled without entry: pending under `"explicit"`, `staticFile` or missing under `"static-fallback"`); an `unavailable` bundled entry → missing, and `compileAudioPlan` then has no track for it and one `missing-audio` issue while the other tracks remain; a `pending` bundled entry → no track and one `pending-audio` issue (never `missing-audio`); a `ready` ref whose duration is not yet in the map → `pending-audio`.
- `tests/types/audio-sources.typecheck.ts` (compiled by `tsc` in `npm run lint`): an `AudioSourceMap` accepts `{ding: {kind: "unavailable"}}` (Player) and `{ding: {kind: "static", path: "__local-assets/ding.wav"}}` (CLI staged override); `// @ts-expect-error` on assigning `{kind: "unavailable"}` to a `LocalAssetSourceMap` entry; `ToraVideoProps` accepts `audioSources` + `bundledAudioPolicy`.
- `tests/web-preview.test.mjs` (extend): `getWebPlayerConfig(story, map)` gives 81 frames for a 2.2 s `auto` voice, the 90-frame fallback without the map entry, and `ceil((4.5 + 0.5) × 30) = 150` for a 4.5 s voice (not cut at the fallback); Preview passes the same map to `inputProps` and to the config; Player props include `initiallyMuted` and volume controls; volume persistence survives a throwing `localStorage`.
- Browser (`tests/browser/audio-preview.spec.mjs`, Chromium): with a bundled-sfx Story, the Player starts muted, clicking unmute starts playback past frame 0, seeking works; with no audio the Player behaves as in v0.3 and shows no volume button; adding a bundled sfx to that Story while the Player is mounted (and playing) shows the volume button and `player.isMuted()` is true, with the current frame preserved; removing it and adding it again mutes again even if the user had unmuted in between. Adversarial case: with the Player playing and unmuted, go audio → no audio → audio while an init script records every `HTMLMediaElement.prototype.play` call, every `AudioBufferSourceNode.start`/`AudioScheduledSourceNode.start` call and the Player's `mutechange` events with timestamps; assert that every audio start after the transition happens while `player.isMuted()` is true and after the `mutechange` to muted, and that no audible start happens until the test clicks unmute. Unit (`tests/web-preview.test.mjs`, fake Player ref): the order log is `mute` → `StoryAudio` receives `audioArmed: true`, never the reverse, and `Preview`'s first `inputProps` have `audioArmed: false`. `tests/story-audio.test.mjs` (render `RemotionRoot`'s composition with its default props and a Story with a bundled sfx, no `audioArmed` prop): one `<Audio>` is mounted; with `audioArmed: false` none is.

## Verify

```bash
npm test
npm run lint
npm run web:build
npm run test:browser
npx playwright test --config=playwright.browser-render.config.mjs
```

## Done when

The plan tests pass, the Player plays bundled sounds after unmute, and every v0.3 golden is unchanged.
