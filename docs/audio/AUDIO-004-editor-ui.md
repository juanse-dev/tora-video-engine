# AUDIO-004 — Editor: music panel, scene audio, My audio cards and audio timeline

Status: not started

Depends on: AUDIO-002, AUDIO-003. Read [README](./README.md) first.

## Goal

Every audio field can be authored in the visual editor without touching YAML; the user can listen to library sounds, see waveforms, and understand what the mix will do (warnings from the plan). The audio timeline under the Player is read-only in v0.4.

## UI

### Music panel (Story level, above the scene list)

- `Music` select: `None`, a `Bundled` group (catalog entries, music first; entries with `file: null` are absent), a `My audio` group (library rows by label). Selecting `None` removes `music` from the Story.
- When a track is set: `Volume` and `Ducking` sliders (`0`–`1`, step `0.05`, numeric value shown), `Fade in` / `Fade out` number inputs (seconds, `0`–`10`, step `0.1`). Values equal to the default are omitted from the Story (canonical YAML stays minimal).

### Per scene (in each scene editor)

- `Sound effect` and `Voice` selects with the same groups plus `None`; each with a `Volume` slider when set.
- Duration: the existing number input plus a checkbox `Auto (from voice)`, enabled only when the scene has a voice. When checked, the number input is replaced by read-only text `auto · 4.3 s` (the timeline's resolved seconds, or `auto · voice not available` for a `fallback` scene). Unchecking restores the last numeric value (or the resolved seconds rounded to 0.1 s).

### My audio cards (from AUDIO-003, extended)

- A waveform thumbnail (canvas from stored peaks, `aria-hidden`), label, `m:ss` duration.
- A play/stop toggle (`Play <label>` / `Stop <label>`). One preview at a time across the page; starting the Player pauses previews and starting a preview pauses the Player. Previews use an `HTMLAudioElement` on the verified payload's object URL (the same URL pool as images).
- Delete warning counts uses across roles: `Used by the music and 2 scenes.` / `Used by scene 3.` etc.

### Audio timeline (under the Player)

- Scene blocks proportional to `durationInFrames` with their number; a music lane and an effects/voice lane.
- Music lane: the music waveform drawn per plan copy, with the gain envelope (fades × ducking × crossfades from the plan's `gainAt`, sampled once per frame column) drawn as a line over it.
- Effects/voice lane: each sfx and voice track's waveform at its `fromFrame`, clipped to `durationInFrames`.
- A playhead synced to the Player's current frame; click/tap seeks; keyboard: the timeline is one focusable element, `ArrowLeft`/`ArrowRight` seek to the previous/next scene start, `Home`/`End` to the start/end. `aria-label` announces the current scene and time.
- Missing/pending audio shows a hatched block with the role label instead of a waveform.
- Rendering cost: draw on one `<canvas>` per lane, redraw on Story/plan change and on resize, never per Player frame (only the playhead moves, as a positioned element).

### Warnings (inline, near the relevant control; `role="status"`)

From `plan.issues` and `plan.maxSimultaneousGain`: `Voice is cut by 1.2 s.` (scene), `Fades shortened to fit the Story.` (music panel), `Audio not available: render blocked.` (the field whose ref is missing), `The mix may clip (peak gain 1.4).` (music panel), `This music is too short to loop (under 1 s); it plays once.` (music panel). Budget failures come from AUDIO-005's readiness message.

## Decisions specific to this spec

- All new controls live inside the existing authoring fieldset, so render/import locks disable them like every other authoring control.
- Visual-draft rules from v0.2 apply: every edit produces a candidate Story validated by the schema and the browser policy; an invalid candidate stays a pending draft.
- The YAML editor needs no change beyond AUDIO-001's serializer; switching modes round-trips every audio field.

## Tasks

1. [ ] Music panel + per-scene sfx/voice selects and volumes + `Auto (from voice)`.
2. [ ] My audio cards: waveform thumbnail, preview playback with the single-preview rule, multi-role delete counts.
3. [ ] Audio timeline (lanes, waveforms, envelope, playhead, seek, keyboard).
4. [ ] Plan warnings in the editor.

## Tests

- `tests/web-editor.test.mjs` (extend): pure helpers for select options (bundled with `file: null` excluded), default-omission when writing fields, auto toggle state transitions, delete-count copy across roles.
- `tests/audio-timeline.test.mjs`: pure layout helpers (block x/width from frames, playhead position, scene-start seek targets, envelope sampling per column).
- `tests/browser/audio-editor.spec.mjs` (Chromium): set music/sfx/voice through the UI and check the exported YAML; `Auto (from voice)` disabled without a voice and showing `auto · 2.7 s` for the 2.2 s fixture; preview play/stop and the Player-pauses-preview rule; timeline click seeks the Player; arrow keys move between scene starts; each warning appears for its fixture Story; render lock disables every new control.

## Verify

```bash
npm test
npm run lint
npm run web:build
npm run test:browser
```

## Done when

A Story with music, effects, voices and `auto` durations can be authored, listened to and inspected entirely in the visual editor, and exports the expected canonical YAML.
