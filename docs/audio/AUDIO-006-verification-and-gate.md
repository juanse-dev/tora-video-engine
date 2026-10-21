# AUDIO-006 — Audio goldens, CLI parity, production gate and release

Status: not started

Depends on: AUDIO-001 … AUDIO-005, including AUDIO-001 task 7 (owner-supplied music). Read [README](./README.md) and [GATE-001](../release/GATE-001-deployed-verification-suite.md) first.

## Goal

Prove end to end, with measurements, that the mix the plan describes is the mix both renderers produce, that Stories without audio are unchanged, and that audio survives the production A → B deploy like images did in v0.3. Then release v0.4.0.

## Reference Story

`stories/audio-reference.yaml` (committed; local refs are the AUDIO-003 fixtures' digests):

| Scene | Duration | Audio | What it proves |
| --- | --- | --- | --- |
| — | — | `music`: 220 Hz 12 s **WAV** fixture (longer than the Story: no loop), `volume: 0.6`, `fadeIn: 0.5`, `fadeOut: 1.0`, default `duck` | fades, ducking |
| 1 | 3 s | none | **positive control**: music only at a known level |
| 2 | 3 s | `sfx`: 880 Hz 0.4 s fixture | sfx onset at 3.0 s |
| 3 | `auto` | `voice`: 440 Hz 2.2 s **WAV** fixture (PCM: container duration exactly 2.2 s) | auto = 81 frames; ducking during the voice |
| 4 | 3 s | none | fade-out |

Total `T = 90 + 90 + 81 + 90 = 351` frames (11.7 s). Pure tones make every other measurement exact, but they cannot verify a loop seam (D-4: crossfading two copies of one tone depends on their phase), so the loop has its own Story:

`stories/audio-loop-reference.yaml`: one 7 s scene, no sfx/voice, `music`: the **2.0 s seeded low-passed noise MP3** fixture (`volume: 1`, no fades, `duck` irrelevant). MP3 on purpose: a native `<Audio loop>` drops out 19–38 ms at each seam (S-3); the crossfaded plan must not. Container duration ≈ 2.0376 s (measured with `inspectAudio` on the committed fixture) → 61 frames, `X = 9`, stride 52 frames: seams at ≈ 1.73, 3.47, 5.20 s.

## Measurements (shared helper `tests/helpers/audioEnvelope.mjs`)

Decode the MP4's audio to 48 kHz mono float WAV with the repository ffmpeg; for 100 ms windows compute RMS and Goertzel magnitude at 220, 440 and 880 Hz, normalized by the positive control (scene 1, 1.0–2.5 s: music at `0.6`). Assertions, with `A` = the control's 220 Hz magnitude:

1. **Control present**: `A` is above an absolute floor (decode not silent).
2. **Fade-in**: the 220 Hz magnitude in 0.0–0.1 s is `< 0.3 A`; 0.6–1.0 s is within ±10% of `A`.
3. **Sfx onset**: 880 Hz (2640 Hz for the gate variant's bundled `ding`, see the gate task) is absent (< 5% of its own peak) in 2.8–2.9 s and present in 3.0–3.3 s.
4. **Ducking**: during 6.3–8.0 s (voice) the 220 Hz magnitude is `0.35 A` ±10%; 440 Hz is present.
5. **Auto duration**: the video track has exactly `T = 270 + ceil((d + 0.5) × 30)` frames, where `d` = `inspectAudio(voice fixture).durationSeconds` (AINV-3); for the WAV reference `d = 2.2` and `T = 351`. 440 Hz is absent from `6.0 + d + 0.1` s on. The expected `T` is always computed from the inspected `d`, never hard-coded, because lossy containers add encoder padding (the committed 2.0 s noise MP3 reports ≈ 2.0376 s, measured with `inspectAudio` on the committed fixtures).
6. **Loop seam** (loop Story): broadband RMS in 20 ms windows with a 10 ms hop over 0.3–6.7 s stays within `[0.6, 1.6] ×` the median window RMS of the same span. A 19 ms zero gap (the native-loop dropout) pulls a window below 0.3× and fails; the check was validated in task 1 against a synthetic file with a 19 ms gap (must fail) and one without (must pass).
7. **Fade-out**: the last 0.1 s (`T/30 − 0.1` to `T/30`) is `< 0.3 A`.
8. **Silent Story unchanged**: `stories/friday-deploy.yaml` still renders a video-only MP4 that passes the v0.3 golden.

## Tasks

### Part A — automated

1. [ ] Extend `tests/helpers/audioEnvelope.mjs` (created in AUDIO-005 with `decodeMp4AudioMono` and `goertzelWindows`) with RMS windows, control normalization and the measurement assertions, with node:test unit tests on synthetic WAVs (known tones and levels, including a silent file that must fail assertion 1, and the seeded noise loop rendered by hand with and without a 19 ms gap for assertion 6).
2. [ ] Browser audio golden: `tests/browser/browser-render-audio-golden.spec.mjs` (system Chrome, `playwright.browser-render.config.mjs`): seed the fixtures into My audio, render both reference Stories, download, assert the AUDIO-005 metadata check plus ffprobe `profile=LC` (the repository ffprobe prints `1`) and, when the page's Chrome encodes AAC natively, `bit_rate` 128 kb/s ±10% on the downloaded file (the WASM AAC fallback ignores the bitrate, D-13), measurements 1–5 and 7 on the main Story and 6 on the loop Story; keep the downloaded MP4 as a CI artifact.
3. [ ] CLI parity: `npm run video -- stories/audio-reference.yaml` with `TORA_LOCAL_ASSETS_ROOT` pointing at an `audio/` copy of the fixtures; the same for the loop Story; same frame counts; measurements 1–7; and, on the main Story, per 100 ms window the browser and CLI envelopes differ by at most 5% of `A` per frequency after aligning by the best lag in `[-60, +60]` ms (D-15).
4. [ ] CI: add both to `.github/workflows/ci.yml` next to the existing goldens; upload the audio MP4s as artifacts.
5. [ ] GATE-001 extension (`tests/gate/audio-gate.spec.mjs`, network guard on; the guard also flags any request body containing audio magic bytes: `ID3`, MP3 frame sync, `RIFF…WAVE`, `ftyp`, `OggS`):
   - **Phase A**: import the 12 s music WAV and the 2.2 s voice **MP3** through My audio (two containers; the MP3 exercises a lossy import, so its auto scene is `ceil((d + 0.5) × 30)` frames with its inspected `d` ≈ 2.2465 s (measured with `inspectAudio` on the committed fixtures), 83 frames and `T` = 353); apply a gate variant of the reference Story, `tests/gate/fixtures/audio-gate-story.yaml`, identical except that scene 2's sfx is the bundled `ding` so a bundled file is exercised too (for the gate variant measurement 3 is taken at 2640 Hz, the bundled `ding`'s fundamental, `DING_HZ` in `tests/helpers/audioIntegration.mjs`, with the same absent and present windows: the CC0 `ding` has no 880 Hz energy, and it sounds for 1.8 s from 3.0 s, inside scene 2); reload and relaunch the profile → My audio, Story and Player recover with no re-import; render and download; metadata check (frame count = the `T` computed from the imported MP3's stored `durationSeconds`, read from My audio) + measurements 1, 3, 4, 5; export YAML has only the expected refs.
   - **Phase B** (after Deploy B, same profile): My audio is still there (IndexedDB version 2), the Story recovers, render with audio succeeds with the same checks.
   - Report rows added to `report.md` (G7) under a new `## v0.4 audio record` table: fixtures with their inspected durations, the expected and actual `T`, render metadata, measurement results, phase B result.
6. [ ] Docs: README status line and roadmap, `docs/audio/README.md` exit status, release notes draft.

### Part B — production gate (human only)

The owner runs, in Windows PowerShell 5.1 (no `&&`; use `npm.cmd`), from the gate worktree:

```powershell
npm.cmd run gate -- --url=prod --phase=A --fresh
```

then, after merging a later commit to `main` and Netlify publishing it:

```powershell
npm.cmd run gate -- --url=prod --phase=B
```

and pastes `report.md` back. Implementers and agents never run the gate against production or any `*.netlify.app` URL.

## Completion checklist

- [ ] AUDIO-001 … AUDIO-005 tasks ticked, including AUDIO-001 task 7 (music supplied, LICENSES rows).
- [ ] Browser audio golden and CLI parity green in CI.
- [ ] v0.3 goldens and the v0.3 gate specs green, unchanged (AINV-6).
- [ ] Production gate phase A and phase B PASS, report pasted into the release.
- [ ] Tag `v0.4.0` on the Deploy B commit and a GitHub Release "v0.4.0 — Videos with sound" with notes and the gate report.

## Done when

Every checklist item is ticked.
