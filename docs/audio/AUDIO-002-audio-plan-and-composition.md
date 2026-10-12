# AUDIO-002 — Audio plan, composition and Player audio

Status: not started

Depends on: AUDIO-001. Read [README](./README.md) first.

## Goal

One pure function, `compileAudioPlan`, decides every sound in the video: where it starts, how long it plays and its gain on every frame (AINV-4). A thin React component turns the plan into `@remotion/media` `<Audio>` elements inside `<Sequence>`s, so the Player, the browser render and the CLI all play the same mix. The Player gets volume controls and starts muted (D-12).

## Plan semantics

All times below are in frames at the composition FPS; seconds are converted with `Math.round(seconds * fps)` unless stated. `T` = `timeline.durationInFrames`.

- **Track sources.** A track is emitted only when its ref's duration is in `audioDurations` **and** the caller marks its source as available (`isAvailable(ref)`). Otherwise the plan records an issue `{kind: "missing-audio", ref, role, sceneIndex?}` and emits nothing for it (AINV-5).
- **Music.** Let `D = round(musicSeconds * fps)`, `X = round(MUSIC_CROSSFADE_SECONDS * fps)`. If `D >= T`, one copy `[0, T)`. Otherwise copies start at `k * (D - X)` for `k = 0, 1, …` while the start is `< T`; copy `k` lasts `min(D, T - start)`. In each overlap of `X` frames the outgoing copy's gain falls linearly 1→0 and the incoming one's rises 0→1 (equal-gain linear crossfade). No `<Audio loop>` (D-4).
- **Music envelope.** `gain(f) = volume × fade(f) × duckGain(f) × crossfade(f)`, where `fade` is a linear ramp over `fadeIn` from frame 0 and over `fadeOut` to frame `T`; if `fadeIn + fadeOut > T / fps`, both are scaled by `(T / fps) / (fadeIn + fadeOut)` and the plan records `{kind: "fades-scaled"}` (D-5).
- **Sfx.** Starts at its scene's `from`; lasts `min(round(sfxSeconds * fps), T - from)` frames; constant gain `volume` (default 1).
- **Voice.** Starts at its scene's `from`; lasts `min(round(voiceSeconds * fps), scene.durationInFrames)`; constant gain `volume`. If the voice is longer than a **fixed** scene, the plan records `{kind: "voice-cut", sceneIndex, seconds}` with the cut length in seconds (D-3).
- **Ducking windows** (D-6). Collect `[start, end)` of every emitted sfx and voice track; sort; merge windows whose gap is `< round(DUCK_MERGE_GAP_SECONDS * fps)` frames. With `R = round(DUCK_RAMP_SECONDS * fps)`, `duckGain` is 1 outside windows, `duck` inside, a linear ramp 1→`duck` over `[start - R, start)` and `duck`→1 over `[end, end + R)`, clamped to `[0, T)`. Overlapping ramps take the minimum gain. With `duck = 1` or no windows, `duckGain ≡ 1`.
- **Clipping hint** (D-7). `maxSimultaneousGain` = the maximum over frames of the sum of all tracks' gains. Computed analytically over the plan's breakpoints, not by iterating every frame of a 9,000-frame Story more than once.

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
  | {kind: "voice-cut"; sceneIndex: number; seconds: number}
  | {kind: "fades-scaled"};
export type AudioPlan = {
  tracks: readonly AudioPlanTrack[];
  issues: readonly AudioPlanIssue[];
  maxSimultaneousGain: number;
};
export const compileAudioPlan: (input: {
  story: Story;
  timeline: Timeline;
  fps: number;
  audioDurations: AudioDurationMap;
  isAvailable: (ref: AudioRef) => boolean;
}) => AudioPlan;
```

A Story without audio yields `{tracks: [], issues: [], maxSimultaneousGain: 0}`.

### `src/audio/sources.ts`

```ts
export type AudioSourceResolution =
  | {kind: "audio"; src: string}            // staticFile(...) for bundled, blob:/static path for local
  | {kind: "pending"; ref: AudioRef}
  | {kind: "missing"; ref: AudioRef};
export const resolveAudioSrc: (ref: AudioRef, localSources: LocalAssetSourceMap | undefined) => AudioSourceResolution;
```

Bundled: `staticFile(entry.file)` when `file` is non-null, else `missing`. Local: same `LocalAssetSource` map as images (`url` → `src`, `static` → `staticFile(path)`, `pending` → pending, absent → missing). Never falls back (AINV-5).

### `src/components/StoryAudio.tsx`

Renders, for each plan track, `<Sequence from={track.fromFrame} durationInFrames={track.durationInFrames} layout="none"><Audio src={…} volume={(f) => track.gainAt(track.fromFrame + f)} /></Sequence>`, with `Audio` from `@remotion/media`. `isAvailable` is `resolveAudioSrc(...).kind === "audio"`. Mounted in `ToraVideo` next to `StoryRenderer` (inside `LocalAssetSourcesProvider`). Renders nothing for a Story without audio.

### Player (`src/web/components/Preview.tsx`)

`initiallyMuted`, `showVolumeControls`, and `audioDurations` passed in `inputProps`. The Player's volume is stored in `localStorage` key `tora.playerVolume` (number in `[0, 1]`) inside try/catch and restored via the Player ref on mount; mute state is never restored as unmuted (D-12). The comment saying Stories are video-only is updated.

## Tasks

1. [ ] Add `@remotion/media@4.0.529` and `mediabunny@1.56.1` (exact) as dependencies.
2. [ ] `compileAudioPlan` with every rule above, plus `tests/audio-plan.test.mjs`.
3. [ ] `resolveAudioSrc` + `StoryAudio` + `ToraVideo` wiring.
4. [ ] Player: muted start, volume controls, remembered volume, `audioDurations` in `inputProps`; the preview's `audioDurations` come from `buildAudioDurationMap(story, localDurations)` where `localDurations` is empty until AUDIO-003 provides library metadata (bundled audio already works).

## Tests

- `tests/audio-plan.test.mjs` (fixture durations: music 10 s, voice 2.2 s, sfx 0.4 s, 30 FPS):
  - no audio → empty plan;
  - music shorter than the Story → copies at `k × (300 − 9)` frames (`X = round(0.3 × 30) = 9`), last copy truncated at `T`, crossfade gains sum to 1 at every overlap frame;
  - music longer than the Story → one copy;
  - fade-in/out values at their endpoints and midpoints; fades scaled + issue when too long;
  - sfx crossing into the next scene keeps playing; sfx past the Story end is truncated;
  - voice cut + `voice-cut` issue with the right seconds; no issue for `auto` scenes;
  - ducking: single window ramps (gain exactly `duck` inside, 1 outside, ramp ends at window start), two windows 0.2 s apart merge, 0.5 s apart do not, `duck: 1` → 1 everywhere, default 0.35;
  - missing duration or unavailable source → no track + `missing-audio` issue with role and scene;
  - `maxSimultaneousGain` for overlapping sfx + voice + ducked music;
  - track keys are stable across calls.
- `tests/audio-sources.test.mjs`: bundled with/without file, local url/static/pending/absent.
- `tests/web-preview.test.mjs` (extend): Player props include `initiallyMuted` and volume controls; volume persistence survives a throwing `localStorage`.
- Browser (`tests/browser/audio-preview.spec.mjs`, Chromium): with a bundled-sfx Story, the Player starts muted, clicking unmute starts playback past frame 0, seeking works; with no audio the Player behaves as in v0.3.

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
