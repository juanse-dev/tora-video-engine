# AUDIO-004 — Editor: music panel, scene audio, My audio cards and audio timeline

Status: implemented

Depends on: AUDIO-002, AUDIO-003. Read [README](./README.md) first.

## Goal

Every audio field can be authored in the visual editor without touching YAML; the user can listen to library sounds, see waveforms, and understand what the mix will do (warnings from the plan). The audio timeline under the Player is read-only in v0.4.

## UI

### Music panel (Story level, above the scene list)

- `Music` select: `None`, a `Bundled` group (catalog entries, music first; entries with `file: null` are absent), a `My audio` group (every library row, no cap, read page by page from the library and sorted by label ignoring case; two rows with the same label are told apart by their duration, `label (0:02)`, and if still equal by a short id). A value the Story holds that no group offers stays selectable as one extra option (`Calm loop (not available)`, `Missing audio abcd…1234`, and `Loading audio…` while the library is opening or its first read is pending). Selecting `None` removes `music` from the Story.
- When a track is set: `Volume` and `Ducking` sliders (`0`–`1`, step `0.05`, numeric value shown), `Fade in` / `Fade out` number inputs (seconds, `0`–`10`, step `0.1`). Values equal to the default are omitted from the Story (canonical YAML stays minimal).

### Per scene (in each scene editor)

- `Sound effect` and `Voice` selects with the same groups plus `None`; each with a `Volume` slider when set.
- Duration: the existing number input plus a checkbox `Auto (from voice)`, enabled only when the scene has a voice. When checked, the number input is replaced by read-only text `auto · 4.3 s` (the timeline's resolved seconds, or `auto · voice not available` for a `fallback` scene). Unchecking restores the last numeric value (or the resolved seconds rounded to 0.1 s). Selecting `None` for Voice in an `auto` scene is **one atomic edit**: the same candidate Story clears the voice and sets the duration to that same restored number, so it validates; the checkbox ends unchecked and disabled and the number input is back. (A Story read from YAML with `auto` and no voice still fails the schema as before.)

### My audio cards (from AUDIO-003, extended)

- A waveform thumbnail (canvas from stored peaks, `aria-hidden`), label, `m:ss` duration.
- A play/stop toggle (`Play <label>` / `Stop <label>`). One preview at a time across the page; starting the Player pauses previews and starting a preview pauses the Player. Previews use an `HTMLAudioElement` on the verified payload's object URL (the same URL pool as images).
- Delete warning counts uses across roles with this wording: `Used by the music and 2 scenes.` / `Used by the music and 1 scene.` / `Used by the music.` (the Story's music is involved: scenes are counted), `Used by scene 3.` / `Used by scenes 1, 3.` (scenes only: their numbers are listed). A file used nowhere gets the plain question without a usage sentence.
- A missing card counts the Active Story's usage (it exists because the Active Story uses the ref); a regular card's delete warning counts the visual draft, so a pending draft is never under-counted. Starting a preview primes the one shared audio element synchronously inside the click (Safari plays only inside the gesture); an authoring lock (import, render, asset dialog) stops a running preview, because its Stop button is an authoring control.

### Audio timeline (under the Player)

- Scene blocks proportional to `durationInFrames` with their number; a music lane and an effects/voice lane.
- Music lane: the music waveform drawn per plan copy, with the gain envelope from `plan.musicEnvelopeAt` (fades × ducking, without crossfade factors; the UI never recomputes mixing), sampled once per frame column and drawn as a line over it.
- Effects/voice lane: each sfx and voice track's waveform at its `fromFrame`, clipped to `durationInFrames`.
- A playhead synced to the Player's current frame; click/tap seeks; keyboard: the timeline is one focusable element, `ArrowLeft`/`ArrowRight` seek to the previous/next scene start, `Home`/`End` to the start/end. `aria-label` announces the current scene and time.
- Waveform sources: local audio uses the stored peaks (`readWaveform(store, digest)`, AUDIO-003). Bundled audio has no digest or stored record; its peaks, its playability and its render readiness all come from **one page-session bundled-audio store**, `src/web/audio/bundledAudio.ts`, the single source of truth for bundled ids in the Player, the timeline and App's render readiness.
  - **Check** for an id: fetch `staticFile(entry.file)`, `inspectAudio`, AUDIO-003's `decodeAudioPeaks`, and the D-9 truncation rule.
  - **State** per id: `{kind: "loading"} | {kind: "retrying"; attempt: 1 | 2 | 3} | {kind: "ready"; peaks; blob; url} | {kind: "fetch-failed"; message} | {kind: "unusable"; message}`. `url` is one object URL of `blob` for the page session, created once.
  - **API**: `requestBundledAudio(ids: Iterable<BundledAudio>)` (starts checks for ids not yet started; cancels, with an `AbortController`, in-flight checks and pending retries for ids no longer requested), `retryBundledAudio(id)` (from `fetch-failed` back to `loading`), `subscribeBundledAudio(listener): () => void`, `getBundledAudioStates(): ReadonlyMap<BundledAudio, BundledAudioState>` (a **new** map object on every transition, the same object otherwise) and `useBundledAudioStates()` (`useSyncExternalStore`).
  - **Who requests**: `App` calls `requestBundledAudio` with the Story's bundled refs (`storyAudioRefs`) whenever that set changes, so every referenced id is checked from page load without any display; no bundled-sound preview exists in this spec, so `App` is the only requester (a future bundled preview must add its id to App's set, because `requestBundledAudio` takes the whole wanted set).
  - **Network errors are transient and recover by themselves**: automatic retries after 1 s, 2 s and 4 s (`retrying`); after the third failed retry the state is `fetch-failed`, and the field shows `Audio could not be loaded.` with a `Retry` button (accessible name `Retry loading <label>`) that calls `retryBundledAudio`. A retry that succeeds publishes `ready` like a first success. An id that stops being requested loses its in-flight fetch, its pending retry and any non-terminal state (`ready` and `unusable` stay for the page session), so requesting it again later starts afresh.
  - **Terminal failures** (an `inspectAudio` rejection, a decode error, the truncation rule) give `unusable`, memoized for the page session (the files are fixed per build); never retried.
  - **Consumers** read `useBundledAudioStates()` at the level that needs them, so every transition re-renders the timeline, the field warning, the Player's source map together; AUDIO-005 adds the Render button's readiness from the same store. `Preview` maps `loading`/`retrying`/`fetch-failed` → `pending`, `ready` → `{kind: "url", url}`, `unusable` → `unavailable`, with `bundledAudioPolicy: "explicit"` (AUDIO-002). Nothing is persisted.
- A `pending-audio` issue shows the loading block described below and no warning text.
- Missing audio, and bundled audio that is `unusable`, shows a hatched block with the role label instead of a waveform, and the field shows `Audio not available: render blocked.` Bundled audio that is `loading` or `retrying` shows a plain block of the right length with the role label; `fetch-failed` shows the same plain block plus `Audio could not be loaded.` and the `Retry` button in the field.
- Rendering cost: draw on one `<canvas>` per lane, redraw on Story/plan change and on resize, never per Player frame (only the playhead moves, as a positioned element).

### Warnings (inline, near the relevant control; `role="status"`)

From `plan.issues` and `plan.maxSimultaneousGain`: `Voice is cut by 1.2 s.` (scene), `Fades shortened to fit the Story.` (music panel), `Audio not available: render blocked.` (the field whose ref is missing), `The mix may clip (peak gain 1.4).` (music panel), `This music is too short to loop (under 1 s); it plays once.` (music panel). Budget failures come from AUDIO-005's readiness message. The voice cut and the peak gain are rounded up to one decimal, so they never read `0.0` or `1.0`. The warnings come from the Active Story's plan and are not shown while a visual draft is pending. Each warning block is a `role="status"` region that stays mounted (only its text changes) and is named by its select's `aria-describedby`; after `Retry` focus returns to the select. A sound that is only loading has no text.

## Decisions specific to this spec

- All new controls live inside the existing authoring fieldset, so render/import locks disable them like every other authoring control.
- Visual-draft rules from v0.2 apply: every edit produces a candidate Story validated by the schema and the browser policy; an invalid candidate stays a pending draft.
- The YAML editor needs no change beyond AUDIO-001's serializer; switching modes round-trips every audio field.

## Tasks

1. [x] Music panel + per-scene sfx/voice selects and volumes + `Auto (from voice)`.
2. [x] My audio cards: waveform thumbnail, preview playback with the single-preview rule, multi-role delete counts.
3. [x] Bundled-audio store (check, retries, `Retry` control, subscriptions), audio timeline (lanes, waveforms from stored peaks and the store, envelope, playhead, seek, keyboard) and the Player's bundled readiness (`"explicit"` policy fed by the store; the AUDIO-002 interim `"static-fallback"` is removed from the Player).
4. [x] Plan warnings in the editor.

## Tests

- `tests/audio-editor-fields.test.mjs` (the pure helpers; `tests/web-editor.test.mjs` is not extended; the multi-role delete wording was implemented and is pinned by AUDIO-003 in `tests/audio-ui.test.mjs`): pure helpers for select options (bundled with `file: null` excluded), default-omission when writing fields, auto toggle state transitions (including Voice → `None` on an `auto` scene: one candidate, voice removed, duration = last numeric value or resolved seconds rounded to 0.1 s, schema-valid), delete-count copy across roles.
- `tests/browser/audio-editor.spec.mjs` also covers bundled waveforms: a Story with `sfx: ding` draws a non-empty effects-lane waveform with no library import, and two scenes using `ding` cause one request for `/audio/sfx/ding.wav`; with `/audio/sfx/ding.wav` routed to undecodable bytes the block is hatched, the field shows `Audio not available: render blocked.` (the Render MP4 readiness message for that failure is **AUDIO-005's assertion**: while the AUDIO-001 interim block exists Render MP4 is disabled for every Story with audio); after that, no `<Audio>` for `ding` is mounted in the Player (no media request for `ding.wav` beyond the waveform fetch, and the Player's plan has no `ding` track), while the Story's music still previews and plays after unmute; on a fresh page whose first request for `ding.wav` fails with a network error and the second succeeds, with no navigation, select or Story change, the automatic retry makes the track appear in the Player without a reload (Render becoming enabled is AUDIO-005's assertion); when all four requests fail, `Retry loading Ding` appears, and clicking it after the route is fixed makes the track appear (Render enabled: AUDIO-005); with the `ding.wav` route held open (check pending) and the Player playing and unmuted, no `<Audio>` for `ding` is mounted and the Player makes no request for it; releasing the route with valid bytes mounts it from a `blob:` URL (no second request for `ding.wav`), and releasing it with undecodable bytes never mounts it; an id dropped from the requested set and requested again fetches afresh, covered by the Node store test (`tests/bundled-audio-store.test.mjs`), not by a Chromium spec.
- `tests/browser/audio-editor.spec.mjs` (integration): a Story with an imported `local:audio:` voice (the 2.2 s fixture) and `sfx: ding`: after unmute the Player mounts both tracks, each from a `blob:` URL; deleting the local asset from My audio removes the voice track, shows `Audio not available: render blocked.` on the voice field and blocks Render, while `ding` still plays.
- `tests/bundled-audio-store.test.mjs` (Node, injected fetch/decode/clock): every transition publishes a new snapshot object and none happens without a transition; network failure → `retrying` 1, 2, 3 at 1 s, 2 s, 4 s → `fetch-failed`, and `retryBundledAudio` → `loading` → `ready`; a terminal failure is memoized and never refetched; an id dropped from `requestBundledAudio` aborts its in-flight fetch and its pending retry; `ready.url` is created once per id; unsubscribe stops notifications.
- `tests/audio-timeline.test.mjs`: pure layout helpers (block x/width from frames, playhead position, scene-start seek targets, envelope sampling per column).
- `tests/browser/audio-editor.spec.mjs` (Chromium): set music/sfx/voice through the UI and check the exported YAML; `Auto (from voice)` disabled without a voice and showing `auto · 2.7 s` for the 2.2 s fixture; on that auto scene, choosing Voice `None` leaves no pending draft, shows the number input with `2.7`, and the exported YAML has `duration: 2.7` and no `voice`; preview play/stop and the Player-pauses-preview rule; timeline click seeks the Player; arrow keys move between scene starts; each warning appears for its fixture Story; an authoring lock disables every new control and stops a running preview (exercised with an asset import in flight, because an audio Story cannot be rendered while the AUDIO-001 interim block exists).

## Verify

```bash
npm test
npm run lint
npm run web:build
npm run test:browser
```

## Done when

A Story with music, effects, voices and `auto` durations can be authored, listened to and inspected entirely in the visual editor, and exports the expected canonical YAML.

## Implementation notes

- The spec body above was rewritten to match the implementation; the points a reader may trip over are the render-readiness assertions (AUDIO-005's), the missing bundled-preview request, and the Node-only "requested again" coverage.
- Pure editor helpers are in `src/web/audio/audioFields.ts`; `lastDuration` (draft memory for `Auto (from voice)`) is never part of the candidate Story and is lost when the YAML editor is opened and closed, after which unchecking uses the resolved seconds rounded to 0.1 s.
- The bundled-audio store is `src/web/audio/bundledAudio.ts`: an HTTP error or a failing body read is transient like a network error; a catalog entry with `file: null` is `unusable` at once; `ready.peaks` is `{peaksPerSecond, peaks}`.
- The Player gets `audioSources` from App with `bundledAudioPolicy: "explicit"`; Remotion Studio keeps `"static-fallback"`.
- The audio timeline is inside `.preview-frame`, one `role="slider"` element; each lane is one canvas redrawn on Story/plan/waveform/width change, never per frame.
- No audio replacement dialog: "Import matching file" with a different audio file is still refused (AUDIO-003).
- **WebKit/Safari playback is not exercised by any gate** (the repository's WebKit project runs one unrelated spec): check the My audio preview by hand once, and add it to the AUDIO-006 checklist.
- Known limits, not fixed here: (1) the My audio page controller loads a card's stored peaks only together with its metadata, so a transient `getWaveform` failure keeps that card on its note glyph until the page is reloaded; (2) the timeline's canvases read `devicePixelRatio` when they render, so a browser zoom change that does not change the element's width leaves them blurry until the next resize; (3) the select's option groups are memoized but `AudioSelect` re-renders with its parent, because its change handlers are new functions on every render.
