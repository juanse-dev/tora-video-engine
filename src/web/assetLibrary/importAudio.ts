import {isDecodeComplete} from "../../audio/decodeCheck.ts";
import {
  AUDIO_EMPTY_MESSAGE,
  AUDIO_TOO_LARGE_MESSAGE,
  audioMimeTypeFor,
  inspectAudio,
  type AudioInspection,
  type AudioMetadata,
} from "../../localAssets/audioInspection.ts";
import {sha256Hex} from "../../localAssets/hash.ts";
import {checkLocalAssetByteSize} from "../../localAssets/imageInspection.ts";
import type {AudioPayloadMetadata} from "../../localAssets/readiness.ts";
import {buildLocalAssetRef, type LocalAudioRef} from "../../localAssets/refs.ts";
import {
  AUDIO_DECODE_FAILED_MESSAGE,
  decodeAudioPeaks,
  type DecodedAudioSummary,
} from "./audioPeaks.ts";
import {
  buildDefaultLabel,
  LocalAssetImportError,
  type ImportPhase,
} from "./importCommon.ts";
import type {WaveformRecord} from "./records.ts";

export {AUDIO_DECODE_FAILED_MESSAGE} from "./audioPeaks.ts";
export const AUDIO_TRUNCATED_MESSAGE = "This audio file looks truncated.";

export type PreparedLocalAudioImport = {
  ref: LocalAudioRef;
  defaultLabel: string;
  originalFilename: string;
  payloadMeta: AudioPayloadMetadata;
  blob: Blob;
  waveform: WaveformRecord;
};

export type PrepareLocalAudioImportDeps = {
  subtle?: SubtleCrypto;
  inspectAudio?: (bytes: Uint8Array) => Promise<AudioInspection>;
  decodePeaks?: (
    blob: Blob,
    metadata: AudioMetadata,
  ) => Promise<DecodedAudioSummary>;
  onPhase?: (phase: ImportPhase) => void;
};

/**
 * Everything that can fail before a write: size gate (before any byte is
 * read), one read, container inspection, one full decode (peaks and the
 * truncation rule) and hashing. The bytes inspected, decoded, hashed and stored
 * are the same bytes. Takes no lock and writes nothing. Throws LocalAssetImportError.
 */
export const prepareLocalAudioImport = async (
  file: File,
  deps: PrepareLocalAudioImportDeps = {},
): Promise<PreparedLocalAudioImport> => {
  // 1. Bound the size before any bytes are read.
  const size = checkLocalAssetByteSize(file.size, "audio");

  if (!size.ok) {
    throw new LocalAssetImportError(
      size.reason,
      size.reason === "empty" ? AUDIO_EMPTY_MESSAGE : AUDIO_TOO_LARGE_MESSAGE,
    );
  }

  // 2. Read once.
  deps.onPhase?.("reading");

  let bytes: Uint8Array;

  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    throw new LocalAssetImportError(
      "malformed",
      "The file could not be read.",
      {cause: error},
    );
  }

  // 3. Container metadata (AINV-7), by content and never by extension or MIME.
  deps.onPhase?.("validating");

  const inspection = await (deps.inspectAudio ?? inspectAudio)(bytes);

  if (!inspection.ok) {
    throw new LocalAssetImportError("audio-rejected", inspection.message);
  }

  const {metadata} = inspection;
  const mimeType = audioMimeTypeFor(metadata.container);
  const blob = new Blob([bytes as BlobPart], {type: mimeType});

  // 4. One full decode: waveform peaks and the D-9 truncation rule.
  deps.onPhase?.("decoding");

  let summary: DecodedAudioSummary;

  try {
    summary = await (deps.decodePeaks ?? decodeAudioPeaks)(blob, metadata);
  } catch (error) {
    throw new LocalAssetImportError(
      "audio-decode-failed",
      AUDIO_DECODE_FAILED_MESSAGE,
      {cause: error},
    );
  }

  if (!isDecodeComplete(summary.decodedSeconds, metadata.durationSeconds)) {
    throw new LocalAssetImportError("audio-truncated", AUDIO_TRUNCATED_MESSAGE);
  }

  // 5. Identity (INV-3): hash of the original bytes.
  deps.onPhase?.("hashing");

  let digest: string;

  try {
    digest = await sha256Hex(bytes, deps.subtle);
  } catch (error) {
    // An environment failure (for example no SubtleCrypto), not a file problem.
    throw new LocalAssetImportError(
      "storage-error",
      "The audio file could not be fingerprinted in this browser.",
      {cause: error},
    );
  }

  return {
    ref: buildLocalAssetRef("audio", digest),
    defaultLabel: buildDefaultLabel(file.name, "audio"),
    originalFilename: file.name,
    payloadMeta: {
      kind: "audio",
      mimeType,
      byteSize: bytes.length,
      container: metadata.container,
      codec: metadata.codec,
      durationSeconds: metadata.durationSeconds,
      sampleRate: metadata.sampleRate,
      channels: metadata.channels,
    },
    blob,
    waveform: {
      peaksPerSecond: summary.peaksPerSecond,
      peaks: summary.peaks,
    },
  };
};
