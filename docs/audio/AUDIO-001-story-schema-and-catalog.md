# AUDIO-001 — Story schema, timeline, persistence v3 and bundled catalog

Status: implemented (task 7 waits for the owner's music)

Depends on: v0.3.3. Read [README](./README.md) first (invariants, constants, grammar, decisions).

## Goal

A Story can declare `music`, per-scene `sfx`/`voice` and `duration: auto`. The schema validates them without any audio bytes (AINV-2); the timeline turns `auto` into frames from a supplied duration map; YAML and browser persistence round-trip the new fields; Stories without audio behave exactly as in v0.3 (AINV-6). The bundled audio catalog exists, with four CC0 sound effects (recordings from Freesound, prepared by `scripts/prepareBundledAudio.mjs`; the first version synthesized them, see task 6) and two music slots.

## Decisions specific to this spec

- `duration` becomes `number | "auto"`. `"auto"` without `voice` is a schema error at `scenes[i].duration`: `duration: auto requires a voice`.
- `volume`, `duck`: finite numbers in `[0, 1]`. `fadeIn`, `fadeOut`: finite numbers in `[0, MAX_FADE_SECONDS]`. Out-of-range values are schema errors.
- The Story-level frame-total check in `StorySchema.superRefine` counts only numeric durations; `auto` scenes are bounded by the browser policy (lower bound at acceptance) and by render readiness (exact durations), see AUDIO-005.
- `compileTimeline(story, fps, audioDurations)`: `audioDurations` is `AudioDurationMap = Readonly<Partial<Record<AudioRef, number>>>` (seconds). Each `TimelineScene` gains `durationSource: "fixed" | "voice" | "fallback"`. Without the voice's entry in the map an `auto` scene uses `AUTO_DURATION_FALLBACK_SECONDS` and `durationSource: "fallback"`.
- `storyHasAudio(story)` is true when any of `music`, a scene `sfx`, a scene `voice`, or a scene `duration: "auto"` is present. It drives persistence version 3 (D-11), the render `muted` flag (D-13) and the "no change" guarantee (AINV-6).
- **The visual editor never loses audio.** `src/web/visualDraft.ts` rebuilds the Story from its draft fields only (`type, pose, background, animation, text, duration`), so today a Story with audio loaded from YAML would silently lose `music`/`sfx`/`voice` on the first visual edit, and `duration: auto` would become `NaN`. In this spec the draft carries `music` (Story) and `sfx`/`voice` (scene) through unchanged, and a scene whose duration is `auto` keeps the draft string `"auto"`, which `visualDraftToCandidate` maps back to the literal. Adding, moving, duplicating and deleting scenes keeps each scene's audio with its scene. AUDIO-004 adds the controls that edit these fields.
- **Acceptance bound for `auto`.** `getStoryMetadata` now needs a duration map, and the browser acceptance policy (`evaluateBrowserStoryPolicy`, which also gates the stored project at start-up before My assets opens) must not depend on asset state. Its default `deriveTotalFrames` becomes `minimumStoryFrames(story, fps)` (in `src/story/timeline.ts`): fixed scenes at their frames, each `auto` scene at `AUTO_DURATION_MIN_FRAMES(fps)` (16 at 30 FPS). The exact check with real durations is AUDIO-005's render readiness.
- Bundled music entries exist in the catalog from the start with `file: null` until the owner supplies the files (task 7). A Story referencing a bundled id whose `file` is null is treated as a **missing** audio asset (AINV-5), never as a schema error.

## Files

| File | Change |
| --- | --- |
| `src/localAssets/refs.ts` | `audio` category, `LocalAudioRef`, `isLocalAudioRef`, `ImageAssetCategory` |
| `src/localAssets/limits.ts` | audio constants from the README table |
| `src/audio/constants.ts` | new: plan/output/waveform constants from the README table |
| `src/audio/catalog.ts` | new: bundled audio catalog |
| `src/story/schema.ts`, `src/story/types.ts` | audio schemas and types |
| `src/story/timeline.ts`, `src/story/metadata.ts`, `src/renderPlan.ts` | required `audioDurations`, `durationSource` |
| `src/StoryRenderer.tsx`, `src/web/previewConfig.ts`, `src/web/App.tsx`, `src/web/components/Preview.tsx` | consume the one shared timeline / map (see below) |
| `src/story/serializeStory.ts` | canonical field order, omit unset optionals |
| `src/Video.tsx`, `src/Root.tsx` | `audioDurations` prop → `calculateMetadata` |
| `src/web/persistence.ts` | version 3 |
| `src/web/visualDraft.ts` | carry `music`/`sfx`/`voice` and `auto` through the draft |
| `src/web/browserPolicy.ts` | default `deriveTotalFrames` = `minimumStoryFrames` |
| `scripts/prepareBundledAudio.mjs` | new: cuts, converts and fades the four CC0 recordings into the effects (replaced the synthesizing `generateBundledAudio.mjs`) |
| `scripts/noiseSynthesis.mjs` | the seeded noise helper that `generateAudioFixtures.mjs` still uses (it was part of `generateBundledAudio.mjs`) |
| `public/audio/sfx/*.wav`, `public/audio/LICENSES.md` | prepared effects + license table |

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
export const compileTimeline: (story: Story, fps: number, audioDurations: AudioDurationMap) => Timeline;
```

`auto` frames = `Math.ceil((seconds + AUTO_DURATION_PADDING_SECONDS) * fps)`; the existing safe-integer checks apply to the result.

**One timeline per composition.** With `auto`, every consumer of the timeline must use the same map, or the scenes' visual `Sequence`s, the composition length and the audio plan disagree. So `audioDurations` is a **required** parameter (pass `{}` explicitly when there is no audio; the type checker then finds every caller): `compileTimeline(story, fps, audioDurations)`, `getStoryMetadata(story, fps, audioDurations)` and `getWebPlayerConfig(story, audioDurations)`. `buildStoryRenderPlan` takes **only** the compiled timeline, `buildStoryRenderPlan(timeline)`, and never compiles one itself. `ToraVideoProps` gains `audioDurations?: AudioDurationMap` (default `{}`); `ToraVideo` compiles the timeline **once** and passes it to both `StoryRenderer` (which calls `buildStoryRenderPlan(timeline)`) and `StoryAudio` (AUDIO-002). `Root.tsx`'s `calculateMetadata` passes `props.audioDurations ?? {}`. In the web app, `App.tsx` (its `previewConfig`) and `Preview` use the same map object the Player receives in `inputProps`. Today's callers: `src/Root.tsx`, `src/StoryRenderer.tsx`/`src/renderPlan.ts`, `src/web/previewConfig.ts` (from `App.tsx` and `Preview.tsx`), `src/web/browserPolicy.ts` (see AUDIO-005 for its bound).

The bundled entries' durations are **not** injected implicitly by `compileTimeline`; `buildAudioDurationMap(refs: Iterable<AudioRef>, localDurations)` (in `src/audio/catalog.ts`) adds every non-null bundled `durationSeconds` among `refs` to `localDurations`. Every caller (Player, App, readiness, CLI) goes through **one** entry point, `storyAudioDurations(story, localDurations = {})` in `src/audio/storyAudio.ts` = `buildAudioDurationMap(storyAudioRefs(story), localDurations)`; nothing else calls `buildAudioDurationMap` with a Story. This keeps the timeline a pure function of its inputs.

### `src/web/persistence.ts`

`PERSISTENCE_VERSION_AUDIO = 3`. Versions only ever go **up** for a durable project, extending today's `requiredPersistenceVersion(story, durableVersion)` (which already keeps a promoted v2 at v2 after the last local ref is removed): `requiredPersistenceVersion = max(durableVersion ?? 1, storyHasAudio(story) ? 3 : storyHasLocalAssetRefs(story) ? 2 : 1)`, evaluated under the existing writer lock. So a v2 project edited to bundled-only stays v2, and a v3 project whose last audio is removed stays v3; a never-promoted project is written at the lowest version its content needs (AINV-6). Reading accepts 1, 2, 3; a version 1 or 2 envelope whose Story uses an audio feature is rejected like v0.3 rejects local refs in version 1 (`Stored project version N cannot contain audio.`).

## Tasks

1. [x] Refs, limits, constants, `src/audio/catalog.ts` with all six ids (music `file: null`), `isBundledAudio`, `buildAudioDurationMap`.
2. [x] Schema + types: `AudioRefSchema`, `AudioClipSchema`, `MusicSchema`, scene `sfx`/`voice`, `duration: "auto"` + its voice rule, Story `music`; frame-total check skips `auto`. `storyHasAudio`.
3. [x] Timeline + metadata + `ToraVideoProps.audioDurations` + `calculateMetadata`.
4. [x] Canonical YAML (`serializeStory.ts`): field order `type, pose, background, animation, text, sfx, voice, duration` per scene and `title, music, scenes` per Story; audio objects `src, volume, fadeIn, fadeOut, duck`; unset optionals omitted. YAML parse → serialize → parse is identity for every fixture.
5. [x] Persistence version 3 (write rule, read rule, the version-mismatch rejection). Test: a v0.3 build's reader (the `PERSISTENCE_VERSION_LOCAL` code path as it is on `main` before this task, kept as a fixture function in the test) treats a version 3 envelope as `unsupported-version` and the app keeps it as a protected recovery snapshot (WEB-005 rule 14).
6. [x] The four sound effects. **Replaced:** the first version was synthesized by `scripts/generateBundledAudio.mjs` (sine partials; 0.6 / 0.8 / 1.2 / 0.12 s) and the owner disliked it. They are now four CC0 recordings from Freesound that the owner chose, prepared by `scripts/prepareBundledAudio.mjs <originalsDir> [outDir]` with the repository ffmpeg: it refuses any original whose sha256 is not the chosen recording, then per effect resamples to 48 kHz, copies mono to both channels, cuts `start` and `length` (exact samples; a whole multiple of 10 ms), applies a gain, and fades the edges (2 ms in, 20-60 ms out, done on the samples because this ffmpeg has no `afade` and its `volume` expression is evaluated once per decoder frame, 21-85 ms). Output is 48 kHz stereo 16-bit WAV in `public/audio/sfx/` and the process is deterministic. The originals are not committed (they live in a git-excluded directory); `tests/bundled-audio.test.mjs` reproduces the committed files from them when they are present and skips with a reason when they are not.

   | id | source | cut (start, length) | gain | file | `durationSeconds` |
   | --- | --- | --- | --- | --- | --- |
   | `whoosh` | freesound.org/people/qubodup/sounds/60013 | 0 s, 0.42 s (40 ms fade-out) | 0 dB | 80 684 B | 0.42 |
   | `boom` | freesound.org/people/Julien_Matthey/sounds/201571 | 0 s, 3.2 s (50 ms fade-out) | -0.9 dB (peak -1.0 dBFS) | 614 444 B | 3.2 |
   | `ding` | freesound.org/people/Saya13/sounds/407258 | 0.705 s, 1.8 s (60 ms fade-out); dominant 2640 Hz | 0 dB | 345 644 B | 1.8 |
   | `pop` | freesound.org/people/deraj/sounds/202230 | 0.19 s, 0.25 s (20 ms fade-out) | 0 dB | 48 044 B | 0.25 |

   `durationSeconds` is filled from `inspectAudio` (AINV-3, checked by `tests/bundled-audio.test.mjs`). `public/audio/LICENSES.md`: one row per file (id, file, source = the Freesound URL plus "trimmed and converted to 48 kHz stereo 16-bit WAV by scripts/prepareBundledAudio.mjs", author = the Freesound user, license = CC0-1.0).
7. [ ] **Owner-supplied music (blocks AUDIO-006, not the other specs).** When the owner provides two CC0 tracks, add them as `public/audio/music/calm-loop.<ext>` and `upbeat-loop.<ext>` (original bytes, MP3/OGG/WAV/M4A, each ≤ 5 MB), set `file` and `durationSeconds`, and add their LICENSES rows (source URL, author, CC0-1.0). Until then the music ids are "missing" (see Decisions).

## Tests

- `tests/audio-refs.test.mjs`: grammar (valid/invalid refs, uppercase hex rejected, category prefix), `isBundledAudio`.
- `tests/story-audio-schema.test.mjs`: every field's bounds (0, 1, 10, negative, NaN, >1, >10), strictness (unknown key in each audio object rejected), `auto` without voice rejected at the right path, `auto` with voice accepted, frame-total check ignores `auto`, `storyHasAudio` for each feature alone and for none.
- `tests/render-plan.test.mjs` (new or extend): for a Story with a 2.2 s `auto` voice, the scene `Sequence` positions from `buildStoryRenderPlan(compileTimeline(story, 30, map))`, `getStoryMetadata` and `getWebPlayerConfig` agree frame for frame when given the same map (81-frame scene, later scenes shifted accordingly).
- `tests/timeline.test.mjs` (extend): `auto` with a known duration (`2.2 s` at 30 FPS → `ceil(2.7 × 30) = 81` frames, `durationSource: "voice"`), unknown → 90 frames `fallback`, fixed scenes unchanged, cumulative `from` correct across mixed scenes, `buildAudioDurationMap` adds bundled durations and skips null ones.
- `tests/story-source.test.mjs` (extend): YAML round-trip for a Story with every audio field and with none; canonical output omits defaults.
- `tests/persistence-v3.test.mjs`: first promotions 1→2 (local ref), 1→3 (audio), 2→3 (audio added to a v2 project); monotonic cases v2 → bundled-only stays 2, v3 → no audio stays 3, v3 → no audio and no local refs stays 3; a fresh project with no durable version is written at 1/2/3 by content; read all three; reject audio in version 1/2; the v0.3 reader fixture treats version 3 as unsupported.
- `tests/web-editor.test.mjs` (extend): a Story with `music`, a scene `sfx`, a scene `voice` and `duration: auto` survives `storyToVisualDraft` → caption edit → `evaluateVisualDraft` with every audio field intact and `auto` preserved; scene add/move/delete keeps each scene's audio on that scene; `minimumStoryFrames` counts `auto` as 16 frames at 30 FPS; the policy accepts 101 `auto` scenes with fixed scenes summing to under the budget.
- `tests/bundled-audio.test.mjs`: every catalog entry with a non-null `file` exists, has a LICENSES row; each effect is 48 kHz stereo 16-bit with the catalog length (equal to `inspectAudio`'s), a peak in -6..-0.5 dBFS, its first sound within 10 ms and no click at either end; a wrong sha256 or a missing original is refused; and, when the originals are present, `prepareBundledAudio.mjs` reproduces the committed files (same header, every sample within 1 LSB).
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
