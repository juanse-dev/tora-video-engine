# Audio roadmap (v0.4)

This directory is the implementation plan for **Tora Video Engine v0.4 — Videos with sound**.

The specs are written to be executed task-by-task by an implementing model or developer **without reopening design decisions**. Every open question is resolved in [Decisions](#decisions). If something is genuinely ambiguous during implementation, stop and ask; do not invent a new mechanism.

The design was validated by a throwaway feasibility spike (AUDIO-000, branch `spike/audio-000`, not merged). Its measured findings are folded into the decisions below and cited as **S-n**.

## Product promise

A Story can have **background music** for its whole length, one **sound effect** per scene and one **voice-over** per scene. A scene with a voice can take its length from the voice (`duration: auto`). Music is lowered automatically while an effect or a voice plays (ducking), fades in and out, and loops seamlessly when it is shorter than the Story.

Sounds come from a small bundled set (synthesized effects plus two music tracks) or from audio files the user imports into **My audio**, which follows the v0.3 local-asset model exactly: bytes stay in this browser's IndexedDB, Stories reference them as `local:audio:sha256:<digest>`, and the CLI finds the same files in `local-assets/audio/`.

The Player plays the mix (muted until the user unmutes it), the editor shows the waveforms on a read-only audio timeline, and both the browser render and the CLI produce **H.264 + AAC-LC 48 kHz stereo** MP4s with the same mix. A Story without any audio renders exactly as in v0.3 (video-only MP4).

v0.4 is single-user, local-first and backend-free, like v0.2 and v0.3.

## Invariants

Referenced from the specs as `AINV-n`. The v0.3 invariants `INV-1`…`INV-12` ([docs/assets/README.md](../assets/README.md#invariants)) keep applying; where they say "image", read "image or audio" unless an AINV narrows it.

| ID | Invariant |
| --- | --- |
| AINV-1 | Story data references audio; it never contains audio bytes, data URLs, blob URLs or paths (extends INV-1). |
| AINV-2 | The Story schema is pure: validating a Story never needs audio bytes or durations. Durations enter only through the timeline (`compileTimeline(..., audioDurations)`). |
| AINV-3 | One audio duration per ref is authoritative everywhere: the **container duration reported by mediabunny** (`inspectAudio().durationSeconds`). Browser and CLI therefore compute identical frame counts for `duration: auto` (S-7: Node cannot decode, so a decoded duration would diverge). |
| AINV-4 | All mixing decisions (start, length, volume per frame, fades, ducking, loop copies) are made by the pure `compileAudioPlan`. React components only map plan tracks to `<Sequence>` + `<Audio>`. |
| AINV-5 | A missing, corrupt or not-yet-ready audio ref never falls back to another sound and never silences the render silently: its track is omitted in the preview, the editor shows it, and MP4 render is blocked (extends INV-5). |
| AINV-6 | A Story that uses no audio produces exactly the v0.3 output: `muted: true`, a video-only MP4, persistence envelope version 1 or 2. |
| AINV-7 | Every audio source is bounded **before** expensive work: bytes `> 0` and `≤ 50 MiB`; exactly one audio track and no video track; duration `> 0` and `≤ 300 s`; sample rate 8–96 kHz; 1 or 2 channels. |
| AINV-8 | Every audio source a render uses was preflighted in the same page session — metadata (container, single audio track, no video track, plausible duration) **and a full decode** of the exact bytes the render will read — before `renderMediaOnWeb` starts (S-9: a bad source otherwise hangs the render ~28 s on an opaque `delayRender` timeout). |
| AINV-9 | Output audio is AAC-LC, 48 kHz, stereo, 128 kb/s, in the browser **and** the CLI. |

## Shared constants

Define each constant exactly once, in the file listed. Import it everywhere else.

| Constant | Value | Defined in |
| --- | --- | --- |
| `MAX_LOCAL_AUDIO_BYTES` | `50 * 1024 * 1024` | `src/localAssets/limits.ts` |
| `MAX_AUDIO_DURATION_SECONDS` | `300` | `src/localAssets/limits.ts` |
| `MIN_AUDIO_SAMPLE_RATE` / `MAX_AUDIO_SAMPLE_RATE` | `8_000` / `96_000` | `src/localAssets/limits.ts` |
| `MAX_AUDIO_CHANNELS` | `2` | `src/localAssets/limits.ts` |
| `MAX_BROWSER_STORY_AUDIO_REFS` | `64` | `src/localAssets/limits.ts` |
| `MAX_BROWSER_STORY_AUDIO_BYTES` | `256 * 1024 * 1024` | `src/localAssets/limits.ts` |
| `AUDIO_TRUNCATION_TOLERANCE_SECONDS` | `0.25` | `src/localAssets/limits.ts` |
| `AUTO_DURATION_PADDING_SECONDS` | `0.5` | `src/audio/constants.ts` |
| `AUTO_DURATION_FALLBACK_SECONDS` | `3` | `src/audio/constants.ts` |
| `AUTO_DURATION_MIN_FRAMES` | `ceil(AUTO_DURATION_PADDING_SECONDS × fps) + 1` (16 at 30 FPS) | `src/audio/constants.ts` (as a function of `fps`) |
| `DEFAULT_AUDIO_VOLUME` | `1` | `src/audio/constants.ts` |
| `DEFAULT_MUSIC_DUCK` | `0.35` | `src/audio/constants.ts` |
| `DUCK_RAMP_SECONDS` | `0.15` | `src/audio/constants.ts` |
| `DUCK_MERGE_GAP_SECONDS` | `0.3` | `src/audio/constants.ts` |
| `MUSIC_CROSSFADE_SECONDS` | `0.3` | `src/audio/constants.ts` |
| `MIN_LOOPING_MUSIC_SECONDS` | `1` | `src/audio/constants.ts` |
| `MAX_FADE_SECONDS` | `10` | `src/audio/constants.ts` |
| `OUTPUT_AUDIO_SAMPLE_RATE` | `48_000` | `src/audio/constants.ts` |
| `OUTPUT_AUDIO_BITRATE` | `128_000` | `src/audio/constants.ts` |
| `WAVEFORM_PEAKS_PER_SECOND` | `50` | `src/audio/constants.ts` |
| `MAX_WAVEFORM_PEAKS` | `15_000` | `src/audio/constants.ts` |
| `PERSISTENCE_VERSION_AUDIO` | `3` | `src/web/persistence.ts` |
| `ASSET_DB_VERSION` | `2` (was `1`) | `src/web/assetLibrary/constants.ts` |

## Stable reference grammar

```text
audio-ref    = bundled-audio-id | local-audio-ref
local-audio-ref = "local:audio:sha256:" 64*64(lowercase-hex)
bundled-audio-id = "whoosh" | "boom" | "ding" | "pop" | "calm-loop" | "upbeat-loop"
```

- `local:audio:` joins `local:pose:` and `local:background:` in `src/localAssets/refs.ts` (`LocalAssetCategory = "pose" | "background" | "audio"`; `ImageAssetCategory = "pose" | "background"` names the image-only paths).
- Any audio ref is valid in any audio role (music, sfx, voice). The role comes from the field, not the ref.
- Bundled ids are one flat namespace in `src/audio/catalog.ts`. A bundled id never changes meaning; new ids may be added.

## Story shape

```yaml
title: Deploy Friday
music:                     # optional, whole Story
  src: calm-loop           # audio-ref
  volume: 0.6              # 0..1, default 1
  fadeIn: 0.5              # seconds 0..10, default 0
  fadeOut: 1.5             # seconds 0..10, default 0
  duck: 0.35               # 0..1 factor while sfx/voice play, default 0.35; 1 disables ducking
scenes:
  - type: chaos
    pose: panic
    background: server-room
    text: Se cayó el sistema!
    sfx:   {src: boom, volume: 0.9}          # optional; starts at scene start, plays to its own end (capped at Story end)
    voice: {src: "local:audio:sha256:…"}     # optional; starts at scene start, cut at scene end
    duration: auto                           # number (seconds) or "auto"; "auto" requires voice
```

All audio objects are **strict** Zod objects. v0.5 (fine control) will add optional fields (`trim`, `offset`, `loop`, curves) to these same objects, so no migration is needed. Canonical YAML omits every optional field the author did not set.

## Decisions

| # | Decision |
| --- | --- |
| D-1 | Data model **A**: declarative fields (`music` on the Story; `sfx`, `voice` per scene), not a global track list. One sfx and one voice per scene in v0.4. |
| D-2 | `duration: auto` = `ceil((voiceDuration + AUTO_DURATION_PADDING_SECONDS) × fps)` frames. If the voice duration is unknown (missing/not ready asset), the scene uses `AUTO_DURATION_FALLBACK_SECONDS` in the preview and render is blocked (AINV-5). |
| D-3 | Voice is cut at the end of its scene; the editor warns `Voice is cut by X.X s` when a fixed duration is shorter than the voice. Sfx plays to its own end even into the next scene, capped at the Story end. |
| D-4 | Music always loops in v0.4 (no `loop` field). Loops are built by `compileAudioPlan` as overlapping copies with an **equal-power** crossfade of `MUSIC_CROSSFADE_SECONDS` (outgoing `cos(πu/2)`, incoming `sin(πu/2)`, `u` from 0 to 1 across the overlap), **not** with `<Audio loop>` (S-3: lossy sources drop out 19–38 ms at each native loop seam). Equal power keeps the loudness of the typical case, where the track's end and start are different (uncorrelated) material; no gain law can preserve the amplitude of a *correlated* signal such as a pure tone, whose result depends on the phase offset between the copies (at the overlap centre two copies of one tone sum to `√2·cos(φ/2)` of its amplitude: ≈ 0.71 at 120°, 0 at 180°), so the seam is verified with a noise fixture, never a tone (AUDIO-006). The crossfade also hides the encoder padding at the end of a copy (MP3 container durations include ~32 ms, S-7): when the outgoing copy goes silent `p` before its end, the incoming gain is already `sin(π/2 · (1 − p / crossfade))`, ≈ 0.99 for 0.3 s. Trade-off accepted: the loop period is 0.3 s shorter than the track, so a track built to loop on the beat drifts by that much per loop; configurable loops come in v0.5. |
| D-5 | Fades apply at the Story edges. If `fadeIn + fadeOut` exceeds the Story length (possible with short `auto` scenes), both are scaled by `length / (fadeIn + fadeOut)` and the editor warns `Fades shortened to fit the Story`. |
| D-6 | Ducking: windows are the union of the intervals where any sfx or voice sounds; windows separated by less than `DUCK_MERGE_GAP_SECONDS` merge. Music gain goes to `duck` with a linear ramp of `DUCK_RAMP_SECONDS` that **ends** at the window start, and ramps back up starting at the window end. Default `duck` is `DEFAULT_MUSIC_DUCK`; `duck: 1` disables it. |
| D-7 | Volume is applied once per frame (Remotion `volume` callback; S-2: a 33 ms staircase, accepted). No limiter: the editor warns `The mix may clip` when the plan's maximum simultaneous gain exceeds 1. |
| D-8 | Audio duration authority is the mediabunny container duration (AINV-3), stored at import (browser) and probed at render (CLI). Bundled durations are constants in the catalog, checked by a test against `inspectAudio`. |
| D-9 | Import validates by content (magic bytes via mediabunny, never extension or MIME): MP3, WAV (PCM), M4A (AAC), OGG (Opus; Vorbis only if the AUDIO-003 Vorbis test passes, see that spec). It fully decodes once to compute waveform peaks and rejects a file whose decoded length is shorter than `durationSeconds − AUDIO_TRUNCATION_TOLERANCE_SECONDS` (S-7: a truncated MP3 is otherwise accepted silently). |
| D-10 | Waveform peaks: `WAVEFORM_PEAKS_PER_SECOND`, at most `MAX_WAVEFORM_PEAKS` values, max-abs per bucket quantized to `Uint8` (0–255), stored in a new IndexedDB store `waveforms` keyed by digest. This bumps `ASSET_DB_VERSION` to 2 and exercises the ASSET-002 blocked-upgrade path. |
| D-11 | Persistence envelope **version 3** is required when the Story uses an audio feature (`music`, `sfx`, `voice` or `duration: auto`). Versions are monotonic per durable project: `max(durableVersion ?? 1, content version)`, so removing the last audio (or local ref) never downgrades a stored project. A never-promoted project without audio keeps version 1/2 as in v0.3 (AINV-6). A v0.3 bundle meeting version 3 treats it as an unsupported version and keeps it as a protected recovery snapshot (existing behaviour, verified by a test in AUDIO-001). |
| D-12 | Player starts **muted** (`initiallyMuted`), with Remotion's volume controls; the user's unmute click creates the AudioContext (S-4: an unmuted Player whose `resume()` never settles stays at frame 0, issue #24). The chosen volume is remembered per viewer in `localStorage` (try/catch, convenience only), but unmuting always needs that first click. |
| D-13 | Browser render: `muted` follows `storyHasAudio(story)` in both `canRenderMediaOnWeb` and `renderMediaOnWeb`; with audio, `audioCodec: "aac"`, `audioBitrate: OUTPUT_AUDIO_BITRATE`. If AAC is unavailable even after the WASM encoder is registered, render is blocked with `This browser cannot encode audio. Use the local CLI: npm run video -- <story.yaml>`. |
| D-14 | CLI render (`@remotion/cli` child process via `buildRenderArgs`): `--audio-codec=aac --audio-bitrate=128k` only when the Story has audio; the silent argument list is unchanged (S-3: the default is ~317 kb/s); bundled audio from `public/audio/`, local audio from `local-assets/audio/` matched by digest with snapshot-on-match. |
| D-15 | Browser/CLI parity is measured on the mix envelope, not bytes: per 100 ms window, Goertzel magnitude per fixture frequency and RMS, after aligning by up to 60 ms (S-3: the CLI's audio starts ~45 ms later). |
| D-16 | Bundled sound effects (`whoosh`, `boom`, `ding`, `pop`) are synthesized by `scripts/generateBundledAudio.mjs` with the repository's ffmpeg (deterministic, project-owned). The two music tracks (`calm-loop`, `upbeat-loop`) are CC0 files supplied by the project owner; each bundled file has an entry (source, author, license) in `public/audio/LICENSES.md`. |
| D-17 | Audio budget per Story in the browser is separate from the image budget: at most `MAX_BROWSER_STORY_AUDIO_REFS` distinct local audio refs and `MAX_BROWSER_STORY_AUDIO_BYTES`. S-6 measured a 300 s Story with music + 20 voices at ~66–74 MB JS heap and ~60 s render. |
| D-18 | Audio components come from `@remotion/media` `<Audio>` at exactly `4.0.529` (it registers the `inline-audio` render assets that `@remotion/web-renderer` mixes). `mediabunny` is pinned to exactly `1.56.1` (the version `@remotion/web-renderer` 4.0.529 uses). |

## Architecture

```text
Story (pure schema) ──► compileTimeline(story, fps, audioDurations) ──► Timeline (auto durations resolved)
                                         │
                                         ▼
                        compileAudioPlan(timeline, story, audioDurations) ──► AudioPlan {tracks, issues, maxSimultaneousGain}
                                         │
            ┌────────────────────────────┼─────────────────────────────┐
            ▼                            ▼                             ▼
  Player (StoryAudio, muted     renderMediaOnWeb (muted:false,   CLI @remotion/cli child (aac 128k,
  until unmute)                 aac, preflighted sources)        staged local-assets/audio)
```

`ToraVideoProps` gains `audioDurations?: AudioDurationMap` (runtime-only, never persisted, like `localAssetSources`). `calculateMetadata` passes it to `getStoryMetadata`, so the composition length uses the same resolved durations everywhere.

### Browser storage layout (IndexedDB version 2)

Unchanged stores (`assets`, `payloadMeta`, `blobs`, `thumbnails`) keep their v0.3 contents. New: `waveforms` (key: digest, value: `{digest, peaksPerSecond, peaks: Uint8Array}`). Audio rows live in `assets` under `local:audio:sha256:…` keys, shaped like image rows; per-digest audio metadata `{kind: "audio", mimeType, byteSize, container, codec, durationSeconds, sampleRate, channels}` lives in `payloadMeta` and the bytes in `blobs`, verified by the D-8 integrity cache (its per-payload ceiling becomes 50 MiB). See AUDIO-003.

## Execution order

| Order | Spec | Deliverable | Depends on |
| --- | --- | --- | --- |
| 1 | [AUDIO-001](./AUDIO-001-story-schema-and-catalog.md) | Ref grammar, Story schema, timeline with `auto`, persistence v3, YAML round-trip, bundled catalog + synthesized effects | v0.3.3 |
| 2a | [AUDIO-002](./AUDIO-002-audio-plan-and-composition.md) | `compileAudioPlan`, `StoryAudio` composition, Player audio | AUDIO-001 |
| 2b | [AUDIO-003](./AUDIO-003-audio-library-and-import.md) | `inspectAudio`, peaks, IndexedDB v2, My audio import/rename/delete/missing, CLI `local-assets/audio` | AUDIO-001 |
| 3a | [AUDIO-004](./AUDIO-004-editor-ui.md) | Music panel, per-scene audio, My audio cards, audio timeline with waveforms, warnings | AUDIO-002, AUDIO-003 |
| 3b | [AUDIO-005](./AUDIO-005-rendering.md) | Browser AAC render with preflight and readiness, CLI audio render | AUDIO-002, AUDIO-003 |
| 4 | [AUDIO-006](./AUDIO-006-verification-and-gate.md) | Audio goldens, CLI parity, GATE-001 extension, release | all |

2a/2b and 3a/3b are independent and can run in parallel (separate worktrees).

## Working conventions

The [v0.3 working conventions](../assets/README.md#working-conventions) apply unchanged (explicit `.ts` imports, `node:test`, injected browser APIs, failing test first, the four verify commands). In addition:

- **Audio sampling tip:** to check sound in a rendered MP4, decode its audio to WAV with the repository ffmpeg (`tests/helpers/ffmpeg.mjs`) and measure per 100 ms window. The test fixtures are pure tones (music 220 Hz, voice 440 Hz, sfx 880 Hz), so a Goertzel magnitude per frequency tells which track sounds and how loud. Always include a positive control (a music-only window at a known level), because a broken decode returns silence that looks like legitimate silence.
- The spike code on `spike/audio-000` (`spike/audio/`) may be read for reference; never merge it.

## v0.4 exit criteria

v0.4 is complete when every spec's tasks are ticked, v0.3 behaviour is unchanged for Stories without audio (the v0.3 goldens and gate pass untouched), and the [AUDIO-006 completion checklist](./AUDIO-006-verification-and-gate.md#completion-checklist), including the human production gate, passes.

## Out of scope (v0.4)

Fine control (trim, offset, configurable loop, volume curves, waveform editing) — planned for v0.5. Also out: more than one sfx or voice per scene, TTS or voice recording in the browser, loudness normalization, a limiter/compressor, audio-only export, video files as audio sources, remote URLs, cloud sync, browser MP4 render with audio in Firefox/Safari (the CLI remains available), and changing the bundled set without a spec.
