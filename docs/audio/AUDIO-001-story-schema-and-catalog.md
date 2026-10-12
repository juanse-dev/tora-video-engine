# AUDIO-001 — Story schema, timeline, persistence v3 and bundled catalog

Status: not started

Depends on: v0.3.3. Read [README](./README.md) first (invariants, constants, grammar, decisions).

## Goal

A Story can declare `music`, per-scene `sfx`/`voice` and `duration: auto`. The schema validates them without any audio bytes (AINV-2); the timeline turns `auto` into frames from a supplied duration map; YAML and browser persistence round-trip the new fields; Stories without audio behave exactly as in v0.3 (AINV-6). The bundled audio catalog exists, with four synthesized effects and two music slots.

## Decisions specific to this spec

- `duration` becomes `number | "auto"`. `"auto"` without `voice` is a schema error at `scenes[i].duration`: `duration: auto requires a voice`.
- `volume`, `duck`: finite numbers in `[0, 1]`. `fadeIn`, `fadeOut`: finite numbers in `[0, MAX_FADE_SECONDS]`. Out-of-range values are schema errors.
- The Story-level frame-total check in `StorySchema.superRefine` counts only numeric durations; `auto` scenes are checked later by the browser policy with resolved durations (AUDIO-005).
- `compileTimeline(story, fps, audioDurations?)`: `audioDurations` is `AudioDurationMap = Readonly<Partial<Record<AudioRef, number>>>` (seconds). Each `TimelineScene` gains `durationSource: "fixed" | "voice" | "fallback"`. Without the map (or without the voice's entry) an `auto` scene uses `AUTO_DURATION_FALLBACK_SECONDS` and `durationSource: "fallback"`.
- `storyHasAudio(story)` is true when any of `music`, a scene `sfx`, a scene `voice`, or a scene `duration: "auto"` is present. It drives persistence version 3 (D-11), the render `muted` flag (D-13) and the "no change" guarantee (AINV-6).
- Bundled music entries exist in the catalog from the start with `file: null` until the owner supplies the files (task 6). A Story referencing a bundled id whose `file` is null is treated as a **missing** audio asset (AINV-5), never as a schema error.

## Files

| File | Change |
| --- | --- |
| `src/localAssets/refs.ts` | `audio` category, `LocalAudioRef`, `isLocalAudioRef`, `ImageAssetCategory` |
| `src/localAssets/limits.ts` | audio constants from the README table |
| `src/audio/constants.ts` | new: plan/output/waveform constants from the README table |
| `src/audio/catalog.ts` | new: bundled audio catalog |
| `src/story/schema.ts`, `src/story/types.ts` | audio schemas and types |
| `src/story/timeline.ts`, `src/story/metadata.ts` | `audioDurations`, `durationSource` |
| `src/story/serializeStory.ts` | canonical field order, omit unset optionals |
| `src/Video.tsx`, `src/Root.tsx` | `audioDurations` prop → `calculateMetadata` |
| `src/web/persistence.ts` | version 3 |
| `scripts/generateBundledAudio.mjs` | new: synthesizes the four effects |
| `public/audio/sfx/*.wav`, `public/audio/LICENSES.md` | generated effects + license table |

## Interfaces

### `src/localAssets/refs.ts`

```ts
export type LocalAssetCategory = "pose" | "background" | "audio";
export type ImageAssetCategory = Exclude<LocalAssetCategory, "audio">;
export type LocalAudioRef = `local:audio:sha256:${string}`;
export const isLocalAudioRef: (value: string) => value is LocalAudioRef;
```

The ref regex becomes `^local:(pose|background|audio):sha256:[0-9a-f]{64}$`. Every existing caller that is image-specific (image inspection, thumbnails, `resolveVisualAssetSrc`, the CLI image scanner) is narrowed to `ImageAssetCategory`; the type checker finds them.

### `src/audio/catalog.ts`

```ts
export const bundledAudioIds = ["whoosh", "boom", "ding", "pop", "calm-loop", "upbeat-loop"] as const;
export type BundledAudio = (typeof bundledAudioIds)[number];
export type BundledAudioEntry = {
  id: BundledAudio;
  label: string;                 // "Whoosh", "Calm loop", …
  kind: "sfx" | "music";         // only a UI grouping hint; any id is valid in any role
  file: string | null;           // path under public/, e.g. "audio/sfx/whoosh.wav"; null = not supplied yet
  durationSeconds: number | null; // mediabunny container duration of `file` (AINV-3); null iff file is null
};
export const bundledAudioCatalog: Readonly<Record<BundledAudio, BundledAudioEntry>>;
export const isBundledAudio: (value: string) => value is BundledAudio;
```

### `src/story/schema.ts`

```ts
export const AudioRefSchema = z.custom<BundledAudio | LocalAudioRef>(/* bundled id or local:audio ref */, {
  message: "Audio must be whoosh, boom, ding, pop, calm-loop, upbeat-loop, or local:audio:sha256:<64 lowercase hex>",
});
export const AudioClipSchema = z.object({src: AudioRefSchema, volume: Unit.optional()}).strict();
export const MusicSchema = z.object({
  src: AudioRefSchema, volume: Unit.optional(),
  fadeIn: FadeSeconds.optional(), fadeOut: FadeSeconds.optional(), duck: Unit.optional(),
}).strict();
// StorySceneSchema: + sfx: AudioClipSchema.optional(), voice: AudioClipSchema.optional(),
//                    duration: z.union([existing positive number schema, z.literal("auto")])
// StorySchema: + music: MusicSchema.optional()
```

### `src/story/timeline.ts`

```ts
export type AudioDurationMap = Readonly<Partial<Record<AudioRef, number>>>;
export type TimelineScene = StoryScene & {
  from: number;
  durationInFrames: number;
  durationSource: "fixed" | "voice" | "fallback";
};
export const compileTimeline: (story: Story, fps: number, audioDurations?: AudioDurationMap) => Timeline;
```

`auto` frames = `Math.ceil((seconds + AUTO_DURATION_PADDING_SECONDS) * fps)`; the existing safe-integer checks apply to the result. `getStoryMetadata(story, fps, audioDurations?)` forwards the map. `ToraVideoProps` gains `audioDurations?: AudioDurationMap`; `Root.tsx`'s `calculateMetadata` passes `props.audioDurations`.

The bundled entries' durations are **not** injected implicitly by `compileTimeline`; callers build the full map with `buildAudioDurationMap(story, localDurations)` (in `src/audio/catalog.ts`), which adds every non-null bundled `durationSeconds` the Story references. This keeps the timeline a pure function of its inputs.

### `src/web/persistence.ts`

`PERSISTENCE_VERSION_AUDIO = 3`. Writing: version 3 iff `storyHasAudio(story)`, else the v0.3 rule (2 iff local refs, else 1). Reading accepts 1, 2, 3; a version 1 or 2 envelope whose Story uses an audio feature is rejected like v0.3 rejects local refs in version 1 (`Stored project version N cannot contain audio.`).

## Tasks

1. [ ] Refs, limits, constants, `src/audio/catalog.ts` with all six ids (music `file: null`), `isBundledAudio`, `buildAudioDurationMap`.
2. [ ] Schema + types: `AudioRefSchema`, `AudioClipSchema`, `MusicSchema`, scene `sfx`/`voice`, `duration: "auto"` + its voice rule, Story `music`; frame-total check skips `auto`. `storyHasAudio`.
3. [ ] Timeline + metadata + `ToraVideoProps.audioDurations` + `calculateMetadata`.
4. [ ] Canonical YAML (`serializeStory.ts`): field order `type, pose, background, animation, text, sfx, voice, duration` per scene and `title, music, scenes` per Story; audio objects `src, volume, fadeIn, fadeOut, duck`; unset optionals omitted. YAML parse → serialize → parse is identity for every fixture.
5. [ ] Persistence version 3 (write rule, read rule, the version-mismatch rejection). Test: a v0.3 build's reader (the `PERSISTENCE_VERSION_LOCAL` code path as it is on `main` before this task, kept as a fixture function in the test) treats a version 3 envelope as `unsupported-version` and the app keeps it as a protected recovery snapshot (WEB-005 rule 14).
6. [ ] `scripts/generateBundledAudio.mjs` (repository ffmpeg via `tests/helpers/ffmpeg.mjs`'s lookup): `whoosh` (0.6 s band-passed noise sweep), `boom` (0.8 s 55 Hz sine + noise burst with exponential decay), `ding` (1.2 s 880 Hz + 1760 Hz partials, exponential decay), `pop` (0.12 s 1.2 kHz click with fast decay); 48 kHz stereo 16-bit WAV in `public/audio/sfx/`; deterministic (same bytes on every run, checked by a test that hashes them). Fill `durationSeconds` from `inspectAudio` once AUDIO-003 task 1 exists — until then from ffprobe, and AUDIO-003 adds the cross-check test. `public/audio/LICENSES.md`: one row per file (id, file, source = "synthesized by scripts/generateBundledAudio.mjs", author = project, license = CC0-1.0).
7. [ ] **Owner-supplied music (blocks AUDIO-006, not the other specs).** When the owner provides two CC0 tracks, add them as `public/audio/music/calm-loop.<ext>` and `upbeat-loop.<ext>` (original bytes, MP3/OGG/WAV/M4A, each ≤ 5 MB), set `file` and `durationSeconds`, and add their LICENSES rows (source URL, author, CC0-1.0). Until then the music ids are "missing" (see Decisions).

## Tests

- `tests/audio-refs.test.mjs`: grammar (valid/invalid refs, uppercase hex rejected, category prefix), `isBundledAudio`.
- `tests/story-audio-schema.test.mjs`: every field's bounds (0, 1, 10, negative, NaN, >1, >10), strictness (unknown key in each audio object rejected), `auto` without voice rejected at the right path, `auto` with voice accepted, frame-total check ignores `auto`, `storyHasAudio` for each feature alone and for none.
- `tests/timeline.test.mjs` (extend): `auto` with a known duration (`2.2 s` at 30 FPS → `ceil(2.7 × 30) = 81` frames, `durationSource: "voice"`), unknown → 90 frames `fallback`, fixed scenes unchanged, cumulative `from` correct across mixed scenes, `buildAudioDurationMap` adds bundled durations and skips null ones.
- `tests/story-source.test.mjs` (extend): YAML round-trip for a Story with every audio field and with none; canonical output omits defaults.
- `tests/persistence-v3.test.mjs`: write version 1/2/3 by feature, read all three, reject audio in version 1/2, v0.3 reader fixture treats version 3 as unsupported.
- `tests/bundled-audio.test.mjs`: every catalog entry with a non-null `file` exists, has a LICENSES row, and the generator is deterministic (hash twice).
- Existing suites unchanged and green (AINV-6), including the browser-render golden.

## Verify

```bash
npm test
npm run lint
npm run web:build
npm run test:browser
npx playwright test --config=playwright.browser-render.config.mjs
```

## Done when

All tasks except 7 are ticked (7 may land any time before AUDIO-006), the existing goldens pass unchanged, and a Story with audio fields validates, round-trips through YAML and browser persistence, and compiles to the expected frames.
