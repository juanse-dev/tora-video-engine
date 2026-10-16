# AUDIO-003 — Audio inspection, My audio library and CLI audio assets

Status: implemented

Depends on: AUDIO-001. Read [README](./README.md) and the v0.3 specs [ASSET-002](../assets/ASSET-002-browser-local-asset-storage.md), [ASSET-003](../assets/ASSET-003-import-and-library-ui.md) and [ASSET-005](../assets/ASSET-005-cli-local-assets.md) first: this spec reuses their mechanisms and only states what differs for audio.

## Goal

Audio files can be imported into the browser library exactly like images (content-addressed, deduplicated, locked, verified, recoverable), with metadata and waveform peaks computed once at import; the CLI finds the same files in `local-assets/audio/`. The editor UI on top of this is AUDIO-004; this spec ships the data layer plus a minimal **My audio** list (import button, card with label/duration, rename, delete, missing card, Import matching file) reusing the v0.3 card components.

## Decisions specific to this spec

- `inspectAudio` reads **metadata only** (no decode) with mediabunny `Input` + `ALL_FORMATS`; it runs unchanged in Node and the browser (S-7). Accepted (container, codec): (`mp3`, `mp3`), (`wave`, `pcm-*`), (`mp4`/`m4a`, `aac`), (`ogg`, `opus`), and (`ogg`, `vorbis`) **only if** task 2 can produce a Vorbis fixture with the repository ffmpeg (the spike found no Vorbis encoder in it; try the native `vorbis` encoder with `-strict -2`) **and** that fixture decodes in Chrome; otherwise Vorbis is rejected with `Ogg Vorbis audio is not supported. Use MP3, WAV, M4A or Ogg Opus.` and the ruling is recorded here. **Ruling: Vorbis is rejected.** The repository ffmpeg has no Vorbis encoder (the native one does not exist in this build: `-c:a vorbis` fails with "Unknown encoder"), so no Ogg Vorbis fixture can be produced and the Chrome decode test cannot run; `inspectAudio` answers an Ogg Vorbis file with the message above.
- Rejections, in this order, each with a user-facing message: empty or `> MAX_LOCAL_AUDIO_BYTES`; not a recognized container; has a video track (`Video files are not supported. Use an audio file.`); not exactly one audio track; codec not accepted; duration not finite, `<= 0` or `> MAX_AUDIO_DURATION_SECONDS`; sample rate not a finite integer in `[MIN_AUDIO_SAMPLE_RATE, MAX_AUDIO_SAMPLE_RATE]`; channel count not exactly `1` or `2` (zero, negative, non-integral or more than `MAX_AUDIO_CHANNELS`: `Audio must be mono or stereo.`). `inspectAudio` never returns metadata outside the `AudioMetadata` type.
- Browser import additionally decodes the whole file once (`decodeAudioPeaks`, mediabunny `AudioSampleSink`) to compute peaks and the decoded length; decode failure → `This audio file could not be decoded.`; `!isDecodeComplete(decodedSeconds, durationSeconds)` (the D-9 truncation rule; zero decoded samples always fails) → `This audio file looks truncated.`. The CLI does not decode while scanning `local-assets/audio/` (Node has no WebCodecs): it relies on `inspectAudio` metadata there, and its render preflight decodes the staged files with ffmpeg (AUDIO-005).
- Peaks: `n = min(ceil(durationSeconds × WAVEFORM_PEAKS_PER_SECOND), MAX_WAVEFORM_PEAKS)` buckets over the decoded length; each value is `round(255 × max |sample| over all channels in the bucket)`. Stored in `waveforms` under key = digest with value `{peaksPerSecond: n / durationSeconds, peaks: Uint8Array}` and **no** identity field: the key is the only authority (INV-11, as v0.3 did for `assets`, `payloadMeta`, `blobs`, `thumbnails`). `readWaveform(digest)` derives identity from the key it requested; a stored value carrying a `digest` field (corrupt or foreign) is rejected by the decoder, never used to look up another entry.
- The integrity check (INV-12 / D-8 cache) for audio payloads verifies SHA-256, byte size and that `inspectAudio` of the bytes matches the stored metadata (container, codec, duration within 1 ms, sample rate, channels); it never decodes. `MAX_LOCAL_ASSET_BYTES` is unchanged for images; the D-8 single-payload ceiling becomes `MAX_LOCAL_AUDIO_BYTES`.
- **Size limits are per category, checked before any byte is read or hashed.** Today every path calls `checkLocalAssetByteSize(byteSize)` (`src/localAssets/imageInspection.ts`, 25 MiB) or compares with `MAX_LOCAL_ASSET_BYTES` directly; left as is, every valid 25–50 MiB audio file would be rejected. Add `maxLocalAssetBytes(category)` in `src/localAssets/limits.ts` (images → `MAX_LOCAL_ASSET_BYTES`, `audio` → `MAX_LOCAL_AUDIO_BYTES`) and change `checkLocalAssetByteSize(byteSize, category)` to use it; update **every** caller with its category: browser import (`importAsset.ts`, `file.size`), the CLI scanner (`scripts/localAssets.ts`, `stats.size` before reading; the category comes from the folder), the `payloadMeta` decoder (`records.ts`, by `kind`), and the integrity reader (`integrity.ts`, by `kind`). Image limits do not change.
- IndexedDB version 2 adds the `waveforms` store in `onupgradeneeded` (no data migration; existing stores untouched). The handler creates a store only when `!database.objectStoreNames.contains(name)` (as since v0.3), so a version 1 database gets exactly `waveforms`. The v0.3 blocked-upgrade behaviour (ASSET-002) is the only path for tabs still on version 1. Rolling the origin back to a v0.3 bundle makes My assets `unavailable` (`VersionError`); this is documented, not handled.
- Payload MIME types for audio: `audio/mpeg`, `audio/wav`, `audio/mp4`, `audio/ogg`, chosen from the inspected container, never from the file's own type.
- Labels default to the filename without extension, as for images. Deduplication is by digest within the `audio` category (`already in My audio`).
- CLI: `categoryFolder.audio = "audio"` (`local-assets/audio/`); candidates are classified by `inspectAudio`, matched by digest, snapshot-on-match, symlinks skipped, exactly as ASSET-005 does for images. `npm run assets` lists audio with duration.

## Interfaces

### `src/localAssets/audioInspection.ts`

```ts
export type AudioMetadata = {
  container: "mp3" | "wave" | "mp4" | "ogg";
  codec: "mp3" | "pcm" | "aac" | "opus" | "vorbis";
  durationSeconds: number;
  sampleRate: number;
  channels: 1 | 2;
};
export type AudioInspection = {ok: true; metadata: AudioMetadata} | {ok: false; message: string};
export const inspectAudio: (bytes: Blob | Uint8Array) => Promise<AudioInspection>;
```

### `src/web/assetLibrary/audioPeaks.ts` (browser only)

```ts
export type DecodedAudioSummary = {decodedSeconds: number; peaks: Uint8Array; peaksPerSecond: number};
export const decodeAudioPeaks: (blob: Blob, metadata: AudioMetadata, deps?: {signal?: AbortSignal}) => Promise<DecodedAudioSummary>;
```

### Library additions

- Storage follows the v0.3 split (`assets` = per-ref row `{label, originalFilename, createdAt}`, `payloadMeta` + `blobs` = per-digest metadata and bytes, `thumbnails` = image derivatives). Audio metadata is **per digest** in `payloadMeta`: `PayloadMetadata` becomes a union, `{kind: "image", mimeType: "image/…", byteSize, width, height}` (existing records without `kind` decode as image) | `{kind: "audio", mimeType: "audio/…", byteSize, container, codec, durationSeconds, sampleRate, channels}`. Audio rows in `assets` are shaped exactly like image rows.
- `records.ts`: the audio `payloadMeta` decoder (strict, INV-11 identity checks, a `local:audio:` row must point at audio metadata and an image row at image metadata), `WaveformRecord` decoder (exactly the keys `peaksPerSecond` and `peaks`; `peaksPerSecond` finite and `> 0`; `peaks` a `Uint8Array` with `1 <= length <= MAX_WAVEFORM_PEAKS`; any extra key, including `digest`, → invalid).
- `store.ts` / `indexedDbStore.ts`: `waveforms` store; an audio import commits row + `payloadMeta` + blob + waveform in **one** transaction; deleting the last ref to a digest removes all of them, as for images.
- `importAsset.ts` / `localAssetImportFlow.ts`: an `audio` branch (inspect → decode peaks → hash → commit) that reuses the lock wait/cancel (`signal`, `onLockAcquired`, #39) and the mismatch / matching-file flows.
- **Story resolution**: `collectStoryLocalAssetUsages` (`src/localAssets/readiness.ts`) includes `local:audio:` refs with their role (`music`, `sfx`, `voice`), so `useStoryLocalAssets` resolves, verifies and creates object URLs for local audio exactly as for images, and `localAssets.sources` carries them (consumed through AUDIO-002's `buildAudioSourceMap`). In the same change the existing image budget receives only image usages: `splitUsagesByCategory(usages)` (`src/localAssets/readiness.ts`) feeds `evaluateLocalAssetBudget` with `image` usages and image metadata, and `evaluateLocalAssetBudget` fails closed on non-image metadata (AUDIO-005 adds the audio budget).
- **Post-lock re-check covers audio.** `VerifiedPayload` (`src/web/assetLibrary/integrity.ts`, `{digest} & PayloadMetadata`) becomes a `kind` union with it, and `samePayload(verified, current)`, the comparison `createLocalAssetRenderPreparation` runs after acquiring the shared Web Lock, is discriminated by `kind`: different kinds → `false` (fail closed); `image` → today's `mimeType`, `byteSize`, `width`, `height`; `audio` → `mimeType`, `byteSize`, `container`, `codec`, `sampleRate`, `channels` and `durationSeconds`, all **exactly** equal (both sides are stored values, so any difference is a change; the 1 ms tolerance applies only when comparing `inspectAudio` of bytes with stored metadata). A mismatch returns `assets-changed` before OPFS cleanup or encoding, as for images.
- Library read API: `readAudioMetadata(ref)`, `readWaveform(digest)` (store first: see Implementation notes); the page's local durations map for `buildAudioDurationMap` is built from the **Story's** refs, never from the visible library page (My assets loads `LOCAL_ASSET_PAGE_SIZE` rows at a time): `readAudioDurations(refs: Iterable<LocalAudioRef>): Promise<AudioDurationMap>` calls `readAudioMetadata` for every local ref in `storyAudioRefs(story)` and omits refs that are absent (they stay `missing`). The page recomputes it when the Story's set of local audio refs changes or a library mutation (import, delete, Import matching file) commits.

## Tasks

1. [x] `inspectAudio` + `tests/audio-inspection.test.mjs`; replace AUDIO-001's ffprobe durations of the bundled effects with `inspectAudio` and add the cross-check test (catalog `durationSeconds` equals `inspectAudio` within 1 µs).
2. [x] Audio fixtures (`tests/fixtures/local-audio/`, generated by `scripts/generateAudioFixtures.mjs`, deterministic, committed): tone 220 Hz 10 s, 440 Hz 2.2 s, 880 Hz 0.4 s in MP3, WAV, M4A, Ogg Opus and Ogg Vorbis (Vorbis with ffmpeg's native encoder and `-strict -2`, if available); tone 220 Hz 12 s WAV (AUDIO-006 main reference); 2.0 s seeded low-passed (< 2 kHz) white noise MP3 (`anoisesrc` with a fixed seed; AUDIO-006 loop reference); mono 440 Hz WAV; 3-channel WAV; a 0-channel WAV (the mono WAV with its `fmt ` channel field patched to 0 by the script); 301 s low-bitrate MP3; MP4 with a video track; truncated MP3 (first 60% of the 10 s file); a non-audio file. Vorbis browser decode test decides the Vorbis ruling.
3. [x] `decodeAudioPeaks` + truncation check (browser harness test in `tests/harness/`).
4. [x] IndexedDB version 2, records, store, transactions; harness tests for the upgrade from a seeded version 1 database (v0.3 rows intact) and the blocked upgrade.
5. [x] Collector + image-budget filter (above); import flow + integrity verification for audio; minimal My audio list in the asset catalog (import, card with label and `m:ss` duration, rename, delete with scene count across `music`/`sfx`/`voice`, missing card, Import matching file).
6. [x] CLI: `local-assets/audio/` scan, staging and `npm run assets` listing.

## Tests

- Size limits (fixtures generated at test time, not committed: a 30 MiB 48 kHz stereo WAV ≈ 164 s, and a 51 MiB file with a valid WAV header): `checkLocalAssetByteSize` accepts 30 MiB audio and rejects a 26 MiB image (image limit unchanged); the 30 MiB WAV imports in the browser (`tests/browser/my-audio.spec.mjs`), is listed by `npm run assets` and is matched and staged by `renderStory` (injected spawn, `tests/cli-local-assets.test.mjs`); the 51 MiB file is rejected on all three paths with a spy proving no read or hash happened; `records.ts` and `integrity.ts` accept a 30 MiB audio `payloadMeta` and reject a 30 MiB image one.
- `tests/audio-decode-check.test.mjs` (Node): `isDecodeComplete` — 0.12 s clip: 0 → false, 0.05 → false, 0.11 → true; 10 s file: 9.8 → true, 9.7 → false, 6.0 → false; `durationSeconds` 0.4 with 0 decoded → false.
- `tests/audio-inspection.test.mjs` (Node): every accepted fixture's metadata; every rejection with its exact message (including the 0-channel and 3-channel WAVs → `Audio must be mono or stereo.`, and an injected non-integral channel count and sample rate); Blob and Uint8Array inputs give the same result.
- `tests/asset-library.test.mjs` (extend): `readAudioDurations` returns the duration of a ref that is not on the first library page (seed `LOCAL_ASSET_PAGE_SIZE + 1` audio rows and reference the last one) and omits an absent ref.
- `tests/asset-library.test.mjs`, `tests/asset-integrity.test.mjs` (extend): audio row/waveform decoding, one-transaction commit and delete, digest-only identity (extended to `waveforms`: a value under key A carrying `digest: B` is rejected and never returns or redirects to B's waveform), integrity mismatch on altered bytes or altered metadata.
- `tests/harness/asset-library-indexeddb.spec.mjs` (extend): version 1 → 2 upgrade keeps v0.3 pose/background rows and payloads; a version 1 connection in a second page blocks the upgrade until it closes; `decodeAudioPeaks` on the fixtures (peaks length, a 220 Hz tone at full scale gives peaks near 255, the truncated MP3 is rejected).
- `tests/local-asset-state.test.mjs` (extend): with a verified `local:audio:` voice, mutating its `payloadMeta` between resolution and the lock (only `durationSeconds`; only `codec`; only `sampleRate`; with `mimeType` and `byteSize` unchanged) returns `assets-changed` before any OPFS or encode call; a `payloadMeta` whose `kind` changed from `audio` to `image` (or the reverse) fails closed with `assets-changed`; an unchanged audio payload passes; image cases keep their current expectations.
- `tests/local-asset-readiness.test.mjs` (extend): the collector returns `local:audio:` usages with roles; image budget totals ignore them; non-image metadata makes `evaluateLocalAssetBudget` fail closed.
- `tests/browser/my-audio.spec.mjs`: import each accepted format → card with duration; duplicate → "already in My audio"; each rejection fixture → message, nothing stored; rename/delete/missing/Import matching file mirror the image tests; delete counts scenes using the ref in any audio role.
- `tests/cli-local-assets.test.mjs` (extend): audio candidates matched by digest, wrong-content `.mp3` ignored, symlink skipped, staging copies bytes snapshot-on-match.

## Verify

```bash
npm test
npm run lint
npm run web:build
npm run test:browser
npm run test:harness
npm run test:cli-e2e
```

## Done when

Audio imports, deduplicates, survives reload, verifies, deletes and recovers like images; the IndexedDB upgrade preserves v0.3 data; the CLI resolves `local:audio:` refs from `local-assets/audio/`.

## Implementation notes

- Duration authority is mediabunny's `getDurationFromMetadata()`, falling back to `computeDuration()`; a truncated MP3 with a Xing header therefore keeps its declared length (10.031 s for the 10 s fixture) while a scan would report 5.98 s, which is what lets the truncation rule catch it.
- Image `payloadMeta` records keep the v0.3 shape (no `kind` field); `kind: "audio"` marks audio, a stored `kind: "image"` is tolerated and dropped on read.
- The library read API takes the store first: `readAudioMetadata(store, ref)`, `readWaveform(store, digest)`, `readAudioDurations(store, refs)`. Peaks are laid over the container duration by timestamp.
- Import: one read of the file, then inspect, decode (peaks and truncation rule), hash, commit. M4A needs a browser that decodes AAC (system Chrome); elsewhere it is refused with `This audio file could not be decoded.`
- "Import matching file" with a different audio file is refused with the mismatch text and writes nothing; no replacement dialog exists: a missing audio ref is replaced by choosing another sound in the Music, Sound effect or Voice select (AUDIO-004).
- `npm run assets` prints the audio section only when `local-assets/audio/` exists. "Staged by `renderStory`" is tested through `stageLocalAssetsForStory`, because the AUDIO-001 interim render block refuses Stories with audio until AUDIO-005.
- Fixtures: the repository ffmpeg has no `anoisesrc`, filters or Vorbis encoder; the noise fixture is a seeded sum of sine partials below 2 kHz (`scripts/generateAudioFixtures.mjs`).
- The real M4A import is verified only in system Chrome (`playwright.browser-render.config.mjs`, `tests/browser/my-audio-m4a.spec.mjs`); bundled Chromium cannot decode AAC and its spec asserts the "could not be decoded" outcome instead.
- The rule "a `local:audio:` row must point at audio metadata, an image row at image metadata" is enforced by `payloadMatchesCategory` in `resolveStoryLocalAssets` (the ref is `corrupt`, its bytes are never read), not by the digest-keyed decoder.
- `buildAudioDurationMap` now drops durations that are not finite or not greater than 0, so a bad stored value can never reach `compileTimeline`.
- Test files were relocated: the new audio unit tests live in `tests/audio-library.test.mjs`, `tests/audio-import.test.mjs`, `tests/audio-ui.test.mjs` and others, instead of extending `tests/asset-library.test.mjs` and `tests/local-asset-flows.test.mjs` as the spec lists.
- `storyHasLocalAssetRefs` stays image-only (it drives persistence version 2 and is pinned by tests). The local-asset gates in `src/web/App.tsx` (browser render resolves and prepares local assets only when `storyHasLocalAssetRefs`) and `scripts/renderStory.ts` (stages local assets only when `storyHasLocalAssetRefs`) are therefore image-only after this spec; AUDIO-005 must widen them to any local ref (images or `local:audio:`) when the interim render block is removed, with a test for a Story whose only local ref is audio.
