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
| 3 | `auto` | `voice`: 440 Hz 2.2 s fixture | auto = 81 frames; ducking during the voice |
| 4 | 3 s | none | fade-out |

Total `T = 90 + 90 + 81 + 90 = 351` frames (11.7 s). Pure tones make every other measurement exact, but they cannot verify a loop seam (D-4: crossfading two copies of one tone depends on their phase), so the loop has its own Story:

`stories/audio-loop-reference.yaml`: one 7 s scene, no sfx/voice, `music`: the **2.0 s seeded low-passed noise MP3** fixture (`volume: 1`, no fades, `duck` irrelevant). MP3 on purpose: a native `<Audio loop>` drops out 19–38 ms at each seam (S-3); the crossfaded plan must not. Container duration ≈ 2.032 s → 61 frames, `X = 9`, stride 52 frames: seams at ≈ 1.73, 3.47, 5.20 s.

## Measurements (shared helper `tests/helpers/audioEnvelope.mjs`)

Decode the MP4's audio to 48 kHz mono float WAV with the repository ffmpeg; for 100 ms windows compute RMS and Goertzel magnitude at 220, 440 and 880 Hz, normalized by the positive control (scene 1, 1.0–2.5 s: music at `0.6`). Assertions, with `A` = the control's 220 Hz magnitude:

1. **Control present**: `A` is above an absolute floor (decode not silent).
2. **Fade-in**: the 220 Hz magnitude in 0.0–0.1 s is `< 0.3 A`; 0.6–1.0 s is within ±10% of `A`.
3. **Sfx onset**: 880 Hz is absent (< 5% of its own peak) in 2.8–2.9 s and present in 3.0–3.3 s.
4. **Ducking**: during 6.3–8.0 s (voice) the 220 Hz magnitude is `0.35 A` ±10%; 440 Hz is present.
5. **Auto duration**: the video track has exactly 351 frames; 440 Hz is absent after 8.3 s.
6. **Loop seam** (loop Story): broadband RMS in 20 ms windows with a 10 ms hop over 0.3–6.7 s stays within `[0.6, 1.6] ×` the median window RMS of the same span. A 19 ms zero gap (the native-loop dropout) pulls a window below 0.3× and fails; the check was validated in task 1 against a synthetic file with a 19 ms gap (must fail) and one without (must pass).
7. **Fade-out**: 11.6–11.7 s is `< 0.3 A`.
8. **Silent Story unchanged**: `stories/friday-deploy.yaml` still renders a video-only MP4 that passes the v0.3 golden.

## Tasks

### Part A — automated

1. [ ] `tests/helpers/audioEnvelope.mjs` with node:test unit tests on synthetic WAVs (known tones and levels, including a silent file that must fail assertion 1, and the seeded noise loop rendered by hand with and without a 19 ms gap for assertion 6).
2. [ ] Browser audio golden: `tests/browser/browser-render-audio-golden.spec.mjs` (system Chrome, `playwright.browser-render.config.mjs`): seed the fixtures into My audio, render both reference Stories, download, assert the AUDIO-005 metadata check, measurements 1–5 and 7 on the main Story and 6 on the loop Story; keep the downloaded MP4 as a CI artifact.
3. [ ] CLI parity: `npm run video -- stories/audio-reference.yaml` with `TORA_LOCAL_ASSETS_ROOT` pointing at an `audio/` copy of the fixtures; the same for the loop Story; same frame counts; measurements 1–7; and, on the main Story, per 100 ms window the browser and CLI envelopes differ by at most 5% of `A` per frequency after aligning by the best lag in `[-60, +60]` ms (D-15).
4. [ ] CI: add both to `.github/workflows/ci.yml` next to the existing goldens; upload the audio MP4s as artifacts.
5. [ ] GATE-001 extension (`tests/gate/audio-gate.spec.mjs`, network guard on; the guard also flags any request body containing audio magic bytes: `ID3`, MP3 frame sync, `RIFF…WAVE`, `ftyp`, `OggS`):
   - **Phase A**: import the 12 s music WAV and the 2.2 s voice MP3 through My audio (two containers); apply a gate variant of the reference Story, `tests/gate/fixtures/audio-gate-story.yaml`, identical except that scene 2's sfx is the bundled `ding` (its 880 Hz partial keeps measurement 3 valid) so a bundled file is exercised too; reload and relaunch the profile → My audio, Story and Player recover with no re-import; render and download; metadata check + measurements 1, 3, 4, 5; export YAML has only the expected refs.
   - **Phase B** (after Deploy B, same profile): My audio is still there (IndexedDB version 2), the Story recovers, render with audio succeeds with the same checks.
   - Report rows added to `report.md` (G7) under a new `## v0.4 audio record` table: fixtures, render metadata, measurement results, phase B result.
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
