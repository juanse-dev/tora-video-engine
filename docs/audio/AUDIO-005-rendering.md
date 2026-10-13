# AUDIO-005 — Browser and CLI rendering with audio

Status: not started

Depends on: AUDIO-002, AUDIO-003. Read [README](./README.md) and [ASSET-004](../assets/ASSET-004-preview-and-browser-rendering.md) / [ASSET-005](../assets/ASSET-005-cli-local-assets.md) first.

## Goal

`Render MP4` in the browser and `npm run video` produce H.264 + AAC-LC 48 kHz stereo 128 kb/s MP4s with the plan's mix whenever the Story has audio (AINV-9), and exactly the v0.3 video-only output when it does not (AINV-6). No render starts with an audio source that has not been preflighted (AINV-8).

## Browser

### Readiness (before the Render button is enabled)

- `collectStoryLocalAssetUsages` includes `local:audio:` refs with their roles, so every ref is still resolved, locked and verified through one list. **Budgets never see the unfiltered list.** Readiness splits it by category first: the `pose`/`background` usages, with only `kind: "image"` metadata, go to today's `evaluateLocalAssetBudget` (unchanged limits: refs, bytes, the 200 MP pixel total); the `audio` usages, with only `kind: "audio"` metadata, go to `evaluateAudioBudget` (`MAX_BROWSER_STORY_AUDIO_REFS`, `MAX_BROWSER_STORY_AUDIO_BYTES`, its own messages `This Story uses more than 64 audio files.` / `This Story's audio is larger than 256 MiB.`). Each budget counts its own refs and bytes. `evaluateLocalAssetBudget` itself becomes fail-closed: a usage whose metadata is not `kind: "image"` (or lacks finite `width`/`height`) returns a failure instead of adding `NaN` to the pixel total; `evaluateAudioBudget` does the same for non-audio metadata.
- **Two different frame checks, on purpose.** (a) The **acceptance** policy (implemented in AUDIO-001; `evaluateBrowserStoryPolicy`, which gates every candidate before it becomes active, including the stored project at start-up, before My assets has opened) must not depend on asynchronous asset state, or a stored Story could be rejected into a recovery snapshot just because durations had not loaded yet. It counts each `auto` scene at its **lower bound** `AUTO_DURATION_MIN_FRAMES = ceil(AUTO_DURATION_PADDING_SECONDS × fps) + 1` (16 at 30 FPS; a voice is `> 0` s) and fixed scenes as today, so it never rejects a Story that could fit. (b) **Render readiness** evaluates `MAX_BROWSER_TOTAL_FRAMES` on the exact `compileTimeline(story, fps, audioDurations).durationInFrames` and blocks with `This Story is longer than 300 s with its voices (N s).` A `fallback` scene (voice not available) already blocks render through the missing-audio state. The Player and timeline UI handle any length (voices are capped at 300 s each, so the worst case is bounded).
- Render is blocked while `plan.issues` contains `missing-audio` (AINV-5). `voice-cut`, `fades-scaled` and clipping are warnings only.
- Capability (D-13): `checkBrowserRenderCapability` calls `canRenderMediaOnWeb` with `muted: !storyHasAudio(story)`; with audio it requests `audioCodec: "aac"` and, if AAC is not natively encodable, awaits the web-renderer's WASM AAC registration before deciding. If AAC is still unavailable: blocked with `This browser cannot encode audio. Use the local CLI: npm run video -- <story.yaml>`. The capability result is cached per `storyHasAudio` value, so a silent Story never pays for the audio probe.

### Transaction

- `prepareLocalAssets` (ASSET-004) prepares audio refs exactly like images: verified payload → object URL, held by the render lease until the post-render cleanup; a change between preparation and render returns `assets-changed`. **Bundled audio is prepared the same way**: the bytes fetched for the preflight become a Blob and an object URL in the render's source map under the bundled id (AUDIO-002 `AudioSourceMap`), revoked with the lease, so the renderer reads exactly the bytes that were decoded and never re-fetches `staticFile` mid-render.
- **Preflight** (AINV-8), inside the same preparation and before OPFS cleanup, for every audio source the plan will use (bundled and local), on the exact bytes the render will read (bundled: fetched once per page session and cached by id; local: the verified payload):
  1. `inspectAudio` succeeds and matches the expected duration within 1 ms (for local refs this is the integrity check already performed; for bundled ones it is new);
  2. **a full decode in this page session** (for bundled audio, of the same Blob the render reads through its object URL): `decodeAudioPeaks` (AUDIO-003) completes without error and its decoded length passes the truncation rule (D-9). Import-time decoding does not count: after a reload, bytes whose metadata still parses could fail to decode, and only a decode proves the renderer will not stall on them.

  Results are cached per digest (local) or id (bundled) for the page session in a `AudioDecodeCache` that follows the integrity cache's rules (D-8 of ASSET-004 R14: one decode at a time page-wide, in-flight sharing per digest, invalidation by a library change wins over an in-flight result, abort only stops waiting). A Story's first render therefore pays at most one decode per distinct source (S-7: ~1 s for a 300 s MP3), later renders none. The preflight honours the render's abort signal. Failure → `{kind: "failure"}` with `Audio file <label> cannot be used for rendering.` and no render. `delayRenderTimeoutInMilliseconds` is set to `30_000` for renders with audio so a source that still stalls fails with a clear timeout instead of hanging.
- `renderMediaOnWeb`: `muted: !storyHasAudio(story)`; with audio, `audioCodec: "aac"`, `audioBitrate: OUTPUT_AUDIO_BITRATE`; `inputProps` include `audioDurations` and the local sources (images + audio). Cancel keeps settling `idle` (v0.3.1).
- Post-render metadata check (extends the existing download check): with audio, the file must have exactly one audio track whose codec string is `mp4a.40.2` (AAC-LC; HE-AAC `mp4a.40.5`/`mp4a.40.29` fails), 48 kHz, 2 channels, an average bitrate (audio packet bytes × 8 / audio duration, from mediabunny packet stats) within `[96, 160]` kb/s so an ignored bitrate setting fails, and an audio duration within `1 / fps` + 60 ms of the video track; the video track keeps the v0.3 checks (H.264, 1080×1920, 30 FPS, frame count = plan `T`). Without audio, the v0.3 check is unchanged (no audio track).

## CLI

- `renderStory` builds `audioDurations` with `storyAudioDurations(story, localDurations)` (AUDIO-001, the same entry point as the browser), where `localDurations` come from `inspectAudio` on the matched `local-assets/audio/` files (AINV-3), and passes it in `inputProps` together with the staged audio sources (`{kind: "static", path}` under `__local-assets/`).
- **Before spawning Remotion**, the CLI compiles the timeline and the plan with the same map and refuses to render while `plan.issues` contains `missing-audio` or `story-too-long-for-audio`, for **every** source kind: a missing local file, and a bundled id whose catalog `file` is null (the placeholder music ids) or whose file is absent from `public/audio/`. The error lists each with its role (`music`, `scene 3 sfx`, `scene 3 voice`), using the image "missing local assets" wording for local refs and `Bundled audio <id> is not available in this build.` for bundled ones. AINV-5: the CLI never renders with an audio source silently omitted.
- **CLI decode preflight** (AINV-8), after staging and before spawning Remotion, for every audio source the plan uses (staged local copies and bundled files in `public/audio/`), on the exact files the render will read. First, metadata: `inspectAudio` on each file must pass every AINV-7 rule (one audio track, no video track, accepted codec, duration and format bounds; staged local copies were already inspected when matched, and are re-inspected here since it is cheap), and a bundled file's `durationSeconds` must equal its catalog value within 1 ms, else `Bundled audio <id> does not match the catalog.`. Only then the decode: `scripts/audioPreflight.ts` runs the ffmpeg binary that ships with Remotion (the compositor-package lookup moves from `tests/helpers/ffmpeg.mjs` to `scripts/ffmpegBinary.ts`, which the test helper then imports) as `ffmpeg -v error -xerror -i <file> -map 0:a:0 -ac 1 -ar 48000 -f f32le -` with a 60 s timeout, counting stdout bytes without buffering them: `decodedSeconds = bytes / (4 × 48_000)`. A non-zero exit, a timeout, or `!isDecodeComplete(decodedSeconds, durationSeconds)` (the D-9 truncation rule, so zero decoded bytes always fails; `durationSeconds` = the same `inspectAudio` value used for the timeline, AINV-3) refuses the render with `Audio file <name> cannot be used for rendering.` and the role list. Sources are checked one at a time; a 300 s MP3 decodes in about a second. Node's lack of WebCodecs does not matter here: the decoder is ffmpeg, the same family Remotion's own audio extraction uses.
- `npm run video` does not call `renderMedia`: `scripts/renderStory.ts` runs the `@remotion/cli` child process with the arguments from `scripts/renderSupport.ts::buildRenderArgs`. That function gains an options parameter, `buildRenderArgs(outputPath, propsPath, publicDir?, {hasAudio})`. With `hasAudio: false` the argument list is **byte-for-byte the v0.3 list** (AINV-6; no `--muted`, no audio flags). With `hasAudio: true` it appends `--audio-codec=aac` and `--audio-bitrate=128k` (D-14; flags verified to exist in `@remotion/renderer` 4.0.529 options `audio-codec`, `audio-bitrate`). Durations reach the composition through the props file (`--props`), which now also contains `audioDurations` next to `story` and the staged sources; `calculateMetadata` (AUDIO-001) reads them.
- The interrupt guard (#37) already removes the staging directory; audio files are staged into the same directory, so no new cleanup path exists. A test asserts it.

## Interfaces

```ts
// src/audio/readiness.ts
export const collectStoryAudioRefs: (story: Story) => Array<{ref: AudioRef; role: AudioRole; sceneIndex: number | null}>;
export const splitUsagesByCategory: (usages: LocalAssetUsage[]) => {image: LocalAssetUsage[]; audio: LocalAssetUsage[]};
export const evaluateAudioBudget: (usages: LocalAssetUsage[], metadata: ReadonlyMap<LocalAssetRef, PayloadMetadata>) => LocalAssetBudgetResult; // audio usages only; non-audio metadata fails closed
// src/web/browserRender.ts
export type BrowserRenderCapability = /* existing */ | {kind: "audio-unsupported"; message: string};
```

## Tasks

1. [ ] Readiness: audio usages, audio budget, acceptance lower bound + exact frame budget at readiness, missing-audio blocking, and blocking any bundled id in AUDIO-004's unusable-bundled-audio store (readiness takes the `useUnusableBundledAudio()` snapshot as an input, so it recomputes when the store changes) with `Audio file <id> cannot be used for rendering.` (no render or preflight is attempted for it).
2. [ ] Capability with audio (AAC native or WASM, cached per `storyHasAudio`).
3. [ ] Preparation + preflight (metadata + session decode, `AudioDecodeCache`) + `delayRenderTimeoutInMilliseconds` + `renderMediaOnWeb` audio options + post-render metadata check.
4. [ ] CLI: durations, staging, missing-audio error, `buildRenderArgs` audio flags and props file contents.

## Tests

- `tests/local-asset-readiness.test.mjs` (extend): a mixed Story at 64 image refs / just under 256 MiB / just under 200 MP plus 64 audio refs / just under 256 MiB of audio passes both budgets, and adding one more of either kind fails only that kind's budget with its own message; audio usages leave the image `refCount`, `totalBytes` and `totalPixels` unchanged; image usages do not consume the audio budget; passing audio metadata to `evaluateLocalAssetBudget` (or image metadata to `evaluateAudioBudget`) fails closed, never `NaN`.
- `tests/web-browser-render.test.mjs` (extend, injected fakes): `muted` and audio options follow `storyHasAudio`; capability probe skipped for silent Stories; WASM registration awaited before deciding; preflight failure (metadata **or** decode) aborts before OPFS cleanup and releases the lease; `AudioDecodeCache` decodes each source once per session, shares in-flight decodes, re-decodes after an invalidation, and abort stops waiting without poisoning the cache; missing-audio blocks; audio budget messages; acceptance policy accepts 101 `auto` scenes (lower bound) with an empty map and readiness then blocks only if the exact total exceeds 9,000 frames; a stored project with `auto` scenes loads as active before My assets opens.
- `tests/render-command.test.mjs` / `tests/cli-local-assets.test.mjs` (extend): `buildRenderArgs` with `hasAudio: false` deep-equals the v0.3 list; with `hasAudio: true` it contains `--audio-codec=aac` and `--audio-bitrate=128k` exactly once; the props file's `audioDurations` deep-equals `storyAudioDurations(story, inspected)` for the same Story and inspected local durations that browser readiness receives (one shared fixture feeds both callers; `tsc` in `npm run lint` compiles both against the one signature); missing-audio error text; a Story using `calm-loop` while its `file` is null fails before the child process is spawned (spawn not called) with `Bundled audio calm-loop is not available in this build.`; a Story longer than 3,600 s with audio fails the same way; `audioPreflight` with an injected spawn: non-zero exit, timeout and a decoded length 0.3 s short of the inspected duration each refuse before Remotion is spawned, and a decoded length 0.2 s short passes; exit 0 with zero stdout bytes for the 0.12 s `pop` is refused; a bundled file replaced by an MP4 with a video track, or by a WAV whose duration differs from the catalog, is refused by the metadata step before any decode; interrupt cleanup covers staged audio.
- `tests/cli-local-assets.e2e.mjs` (extend, real CLI): a Story whose `local-assets/audio/` voice is the truncated MP3 fixture (first 60% of the 10 s file) fails before spawning Remotion with `cannot be used for rendering`; a Story with a bundled sfx renders an MP4 whose ffprobe shows one AAC-LC (`profile=LC`) 48 kHz stereo stream at ~128 kb/s (±10%) and 360 video frames; `stories/friday-deploy.yaml` still has no audio stream.
- `tests/browser/browser-rendering.spec.mjs` (extend, system Chrome): a Story with a bundled sfx renders and downloads an MP4 with one AAC-LC 48 kHz stereo track (ffprobe `profile=LC`, `bit_rate` 128 kb/s ±10%); the post-render check rejects injected metadata with codec `mp4a.40.5` and with an average bitrate of 64 kb/s (unit test, `tests/web-browser-render.test.mjs`); a Story whose local voice was deleted cannot render; a local audio asset seeded (`tests/browser/helpers/seedAssetLibrary.mjs`, digest computed from the seeded bytes so integrity passes) with a file whose metadata parses but whose samples do not decode fails the preflight quickly with the `cannot be used for rendering` message instead of stalling; a Story with a bundled sfx renders through an object URL (the render's source map holds a `blob:` URL for the id, and no request for `/audio/sfx/<id>.wav` happens after the preflight); a silent Story still produces a video-only MP4.

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
