# AUDIO-005 — Browser and CLI rendering with audio

Status: not started

Depends on: AUDIO-002, AUDIO-003. Read [README](./README.md) and [ASSET-004](../assets/ASSET-004-preview-and-browser-rendering.md) / [ASSET-005](../assets/ASSET-005-cli-local-assets.md) first.

## Goal

`Render MP4` in the browser and `npm run video` produce H.264 + AAC-LC 48 kHz stereo 128 kb/s MP4s with the plan's mix whenever the Story has audio (AINV-9), and exactly the v0.3 video-only output when it does not (AINV-6). No render starts with an audio source that has not been preflighted (AINV-8).

## Browser

### Readiness (before the Render button is enabled)

- `collectStoryLocalAssetUsages` includes `local:audio:` refs with their roles; the audio budget (`MAX_BROWSER_STORY_AUDIO_REFS`, `MAX_BROWSER_STORY_AUDIO_BYTES`) is evaluated separately from the image budget, with its own message (`This Story uses more than 64 audio files.` / `This Story's audio is larger than 256 MiB.`).
- The browser Story policy's frame budget (`MAX_BROWSER_TOTAL_FRAMES`) is evaluated on `compileTimeline(story, fps, audioDurations).durationInFrames`, i.e. with `auto` resolved. A `fallback` scene (voice not available) already blocks render through the missing-audio state.
- Render is blocked while `plan.issues` contains `missing-audio` (AINV-5). `voice-cut`, `fades-scaled` and clipping are warnings only.
- Capability (D-13): `checkBrowserRenderCapability` calls `canRenderMediaOnWeb` with `muted: !storyHasAudio(story)`; with audio it requests `audioCodec: "aac"` and, if AAC is not natively encodable, awaits the web-renderer's WASM AAC registration before deciding. If AAC is still unavailable: blocked with `This browser cannot encode audio. Use the local CLI: npm run video -- <story.yaml>`. The capability result is cached per `storyHasAudio` value, so a silent Story never pays for the audio probe.

### Transaction

- `prepareLocalAssets` (ASSET-004) prepares audio refs exactly like images: verified payload → object URL, held by the render lease until the post-render cleanup; a change between preparation and render returns `assets-changed`.
- **Preflight** (AINV-8), inside the same preparation and before OPFS cleanup, for every audio source the plan will use (bundled and local), on the exact bytes the render will read (bundled: fetched once per page session and cached by id; local: the verified payload):
  1. `inspectAudio` succeeds and matches the expected duration within 1 ms (for local refs this is the integrity check already performed; for bundled ones it is new);
  2. **a full decode in this page session**: `decodeAudioPeaks` (AUDIO-003) completes without error and its decoded length passes the truncation rule (D-9). Import-time decoding does not count: after a reload, bytes whose metadata still parses could fail to decode, and only a decode proves the renderer will not stall on them.

  Results are cached per digest (local) or id (bundled) for the page session in a `AudioDecodeCache` that follows the integrity cache's rules (D-8 of ASSET-004 R14: one decode at a time page-wide, in-flight sharing per digest, invalidation by a library change wins over an in-flight result, abort only stops waiting). A Story's first render therefore pays at most one decode per distinct source (S-7: ~1 s for a 300 s MP3), later renders none. The preflight honours the render's abort signal. Failure → `{kind: "failure"}` with `Audio file <label> cannot be used for rendering.` and no render. `delayRenderTimeoutInMilliseconds` is set to `30_000` for renders with audio so a source that still stalls fails with a clear timeout instead of hanging.
- `renderMediaOnWeb`: `muted: !storyHasAudio(story)`; with audio, `audioCodec: "aac"`, `audioBitrate: OUTPUT_AUDIO_BITRATE`; `inputProps` include `audioDurations` and the local sources (images + audio). Cancel keeps settling `idle` (v0.3.1).
- Post-render metadata check (extends the existing download check): with audio, the file must have exactly one AAC track, 48 kHz, 2 channels, and an audio duration within `1 / fps` + 60 ms of the video track; the video track keeps the v0.3 checks (H.264, 1080×1920, 30 FPS, frame count = plan `T`). Without audio, the v0.3 check is unchanged (no audio track).

## CLI

- `renderStory` builds `audioDurations` with `buildAudioDurationMap(story, localDurations)`, where `localDurations` come from `inspectAudio` on the matched `local-assets/audio/` files (AINV-3), and passes it in `inputProps` together with the staged audio sources (`{kind: "static", path}` under `__local-assets/`).
- Missing local audio → the same "missing local assets" error as images, listing audio refs with their roles (`music`, `scene 3 sfx`, `scene 3 voice`).
- `npm run video` does not call `renderMedia`: `scripts/renderStory.ts` runs the `@remotion/cli` child process with the arguments from `scripts/renderSupport.ts::buildRenderArgs`. That function gains an options parameter, `buildRenderArgs(outputPath, propsPath, publicDir?, {hasAudio})`. With `hasAudio: false` the argument list is **byte-for-byte the v0.3 list** (AINV-6; no `--muted`, no audio flags). With `hasAudio: true` it appends `--audio-codec=aac` and `--audio-bitrate=128k` (D-14; flags verified to exist in `@remotion/renderer` 4.0.529 options `audio-codec`, `audio-bitrate`). Durations reach the composition through the props file (`--props`), which now also contains `audioDurations` next to `story` and the staged sources; `calculateMetadata` (AUDIO-001) reads them.
- The interrupt guard (#37) already removes the staging directory; audio files are staged into the same directory, so no new cleanup path exists. A test asserts it.

## Interfaces

```ts
// src/audio/readiness.ts
export const collectStoryAudioRefs: (story: Story) => Array<{ref: AudioRef; role: AudioRole; sceneIndex: number | null}>;
export const evaluateAudioBudget: (usages: LocalAssetUsage[], metadata: ReadonlyMap<LocalAssetRef, PayloadMetadata>) => LocalAssetBudgetResult;
// src/web/browserRender.ts
export type BrowserRenderCapability = /* existing */ | {kind: "audio-unsupported"; message: string};
```

## Tasks

1. [ ] Readiness: audio usages, audio budget, frame budget with resolved durations, missing-audio blocking.
2. [ ] Capability with audio (AAC native or WASM, cached per `storyHasAudio`).
3. [ ] Preparation + preflight (metadata + session decode, `AudioDecodeCache`) + `delayRenderTimeoutInMilliseconds` + `renderMediaOnWeb` audio options + post-render metadata check.
4. [ ] CLI: durations, staging, missing-audio error, `buildRenderArgs` audio flags and props file contents.

## Tests

- `tests/web-browser-render.test.mjs` (extend, injected fakes): `muted` and audio options follow `storyHasAudio`; capability probe skipped for silent Stories; WASM registration awaited before deciding; preflight failure (metadata **or** decode) aborts before OPFS cleanup and releases the lease; `AudioDecodeCache` decodes each source once per session, shares in-flight decodes, re-decodes after an invalidation, and abort stops waiting without poisoning the cache; missing-audio blocks; audio budget messages.
- `tests/render-command.test.mjs` / `tests/cli-local-assets.test.mjs` (extend): `buildRenderArgs` with `hasAudio: false` deep-equals the v0.3 list; with `hasAudio: true` it contains `--audio-codec=aac` and `--audio-bitrate=128k` exactly once; the props file contains `audioDurations` from `local-assets/audio/` (and bundled entries); missing-audio error text; interrupt cleanup covers staged audio.
- `tests/cli-local-assets.e2e.mjs` (extend, real CLI): a Story with a bundled sfx renders an MP4 whose ffprobe shows one AAC 48 kHz stereo stream at ~128 kb/s (±10%) and 360 video frames; `stories/friday-deploy.yaml` still has no audio stream.
- `tests/browser/browser-rendering.spec.mjs` (extend, system Chrome): a Story with a bundled sfx renders and downloads an MP4 with one AAC 48 kHz stereo track; a Story whose local voice was deleted cannot render; a local audio asset seeded (`tests/browser/helpers/seedAssetLibrary.mjs`, digest computed from the seeded bytes so integrity passes) with a file whose metadata parses but whose samples do not decode fails the preflight quickly with the `cannot be used for rendering` message instead of stalling; a silent Story still produces a video-only MP4.

## Verify

```bash
npm test
npm run lint
npm run web:build
npm run test:browser
npx playwright test --config=playwright.browser-render.config.mjs
npm run test:cli-e2e
```

## Done when

Both render paths output the planned AAC track for Stories with audio, refuse to start with unverified or missing audio, and keep v0.3 output for silent Stories.
