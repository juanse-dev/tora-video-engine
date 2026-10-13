# AUDIO-003 — Audio inspection, My audio library and CLI audio assets

Status: not started

Depends on: AUDIO-001. Read [README](./README.md) and the v0.3 specs [ASSET-002](../assets/ASSET-002-browser-local-asset-storage.md), [ASSET-003](../assets/ASSET-003-import-and-library-ui.md) and [ASSET-005](../assets/ASSET-005-cli-local-assets.md) first: this spec reuses their mechanisms and only states what differs for audio.

## Goal

Audio files can be imported into the browser library exactly like images (content-addressed, deduplicated, locked, verified, recoverable), with metadata and waveform peaks computed once at import; the CLI finds the same files in `local-assets/audio/`. The editor UI on top of this is AUDIO-004; this spec ships the data layer plus a minimal **My audio** list (import button, card with label/duration, rename, delete, missing card, Import matching file) reusing the v0.3 card components.

## Decisions specific to this spec

- `inspectAudio` reads **metadata only** (no decode) with mediabunny `Input` + `ALL_FORMATS`; it runs unchanged in Node and the browser (S-7). Accepted (container, codec): (`mp3`, `mp3`), (`wave`, `pcm-*`), (`mp4`/`m4a`, `aac`), (`ogg`, `opus`), and (`ogg`, `vorbis`) **only if** task 2 can produce a Vorbis fixture with the repository ffmpeg (the spike found no Vorbis encoder in it; try the native `vorbis` encoder with `-strict -2`) **and** that fixture decodes in Chrome; otherwise Vorbis is rejected with `Ogg Vorbis audio is not supported. Use MP3, WAV, M4A or Ogg Opus.` and the ruling is recorded here.
- Rejections, in this order, each with a user-facing message: empty or `> MAX_LOCAL_AUDIO_BYTES`; not a recognized container; has a video track (`Video files are not supported. Use an audio file.`); not exactly one audio track; codec not accepted; duration not finite, `<= 0` or `> MAX_AUDIO_DURATION_SECONDS`; sample rate outside `[MIN, MAX]`; more than `MAX_AUDIO_CHANNELS` channels.
- Browser import additionally decodes the whole file once (`decodeAudioPeaks`, mediabunny `AudioSampleSink`) to compute peaks and the decoded length; decode failure → `This audio file could not be decoded.`; decoded length `< durationSeconds − AUDIO_TRUNCATION_TOLERANCE_SECONDS` → `This audio file looks truncated.` (D-9). The CLI does not decode while scanning `local-assets/audio/` (Node has no WebCodecs): it relies on `inspectAudio` metadata there, and its render preflight decodes the staged files with ffmpeg (AUDIO-005).
- Peaks: `n = min(ceil(durationSeconds × WAVEFORM_PEAKS_PER_SECOND), MAX_WAVEFORM_PEAKS)` buckets over the decoded length; each value is `round(255 × max |sample| over all channels in the bucket)`. Stored as `{digest, peaksPerSecond: n / durationSeconds, peaks: Uint8Array}`.
- The integrity check (INV-12 / D-8 cache) for audio payloads verifies SHA-256, byte size and that `inspectAudio` of the bytes matches the stored metadata (container, codec, duration within 1 ms, sample rate, channels); it never decodes. `MAX_LOCAL_ASSET_BYTES` is unchanged for images; the D-8 single-payload ceiling becomes `MAX_LOCAL_AUDIO_BYTES`.
- IndexedDB version 2 adds the `waveforms` store in `onupgradeneeded` (no data migration; existing stores untouched). Today's handler loops over all store names and creates each one; with a version 1 database present that would throw on the existing stores, so it must create a store only when `!database.objectStoreNames.contains(name)`. The v0.3 blocked-upgrade behaviour (ASSET-002) is the only path for tabs still on version 1. Rolling the origin back to a v0.3 bundle makes My assets `unavailable` (`VersionError`); this is documented, not handled.
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
- `records.ts`: the audio `payloadMeta` decoder (strict, INV-11 identity checks, a `local:audio:` row must point at audio metadata and an image row at image metadata), `WaveformRecord` decoder (`peaks.length <= MAX_WAVEFORM_PEAKS`, values are bytes).
- `store.ts` / `indexedDbStore.ts`: `waveforms` store; an audio import commits row + `payloadMeta` + blob + waveform in **one** transaction; deleting the last ref to a digest removes all of them, as for images.
- `importAsset.ts` / `localAssetImportFlow.ts`: an `audio` branch (inspect → decode peaks → hash → commit) that reuses the lock wait/cancel (`signal`, `onLockAcquired`, #39) and the mismatch / matching-file flows.
- Library read API: `readAudioMetadata(ref)`, `readWaveform(digest)`; the page's local durations map for `buildAudioDurationMap` is built from the **Story's** refs, never from the visible library page (My assets loads `LOCAL_ASSET_PAGE_SIZE` rows at a time): `readAudioDurations(refs: Iterable<LocalAudioRef>): Promise<AudioDurationMap>` calls `readAudioMetadata` for every local ref in `storyAudioRefs(story)` and omits refs that are absent (they stay `missing`). The page recomputes it when the Story's set of local audio refs changes or a library mutation (import, delete, Import matching file) commits.

## Tasks

1. [ ] `inspectAudio` + `tests/audio-inspection.test.mjs`; replace AUDIO-001's ffprobe durations of the bundled effects with `inspectAudio` and add the cross-check test (catalog `durationSeconds` equals `inspectAudio` within 1 µs).
2. [ ] Audio fixtures (`tests/fixtures/local-audio/`, generated by `scripts/generateAudioFixtures.mjs`, deterministic, committed): tone 220 Hz 10 s, 440 Hz 2.2 s, 880 Hz 0.4 s in MP3, WAV, M4A, Ogg Opus and Ogg Vorbis (Vorbis with ffmpeg's native encoder and `-strict -2`, if available); tone 220 Hz 12 s WAV (AUDIO-006 main reference); 2.0 s seeded low-passed (< 2 kHz) white noise MP3 (`anoisesrc` with a fixed seed; AUDIO-006 loop reference); mono 440 Hz WAV; 3-channel WAV; 301 s low-bitrate MP3; MP4 with a video track; truncated MP3 (first 60% of the 10 s file); a non-audio file. Vorbis browser decode test decides the Vorbis ruling.
3. [ ] `decodeAudioPeaks` + truncation check (browser harness test in `tests/harness/`).
4. [ ] IndexedDB version 2, records, store, transactions; harness tests for the upgrade from a seeded version 1 database (v0.3 rows intact) and the blocked upgrade.
5. [ ] Import flow + integrity verification for audio; minimal My audio list in the asset catalog (import, card with label and `m:ss` duration, rename, delete with scene count across `music`/`sfx`/`voice`, missing card, Import matching file).
6. [ ] CLI: `local-assets/audio/` scan, staging and `npm run assets` listing.

## Tests

- `tests/audio-inspection.test.mjs` (Node): every accepted fixture's metadata; every rejection with its exact message; Blob and Uint8Array inputs give the same result.
- `tests/asset-library.test.mjs` (extend): `readAudioDurations` returns the duration of a ref that is not on the first library page (seed `LOCAL_ASSET_PAGE_SIZE + 1` audio rows and reference the last one) and omits an absent ref.
- `tests/asset-library.test.mjs`, `tests/asset-integrity.test.mjs` (extend): audio row/waveform decoding, one-transaction commit and delete, digest-only identity, integrity mismatch on altered bytes or altered metadata.
- `tests/harness/asset-library-indexeddb.spec.mjs` (extend): version 1 → 2 upgrade keeps v0.3 pose/background rows and payloads; a version 1 connection in a second page blocks the upgrade until it closes; `decodeAudioPeaks` on the fixtures (peaks length, a 220 Hz tone at full scale gives peaks near 255, the truncated MP3 is rejected).
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
