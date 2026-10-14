import {MAX_WAVEFORM_PEAKS} from "../../audio/constants.ts";
import {
  audioCodecs,
  audioContainers,
  audioMimeTypeFor,
  isAcceptedAudioCombination,
  type AudioCodec,
  type AudioContainer,
} from "../../localAssets/audioInspection.ts";
import {
  MAX_AUDIO_DURATION_SECONDS,
  MAX_AUDIO_SAMPLE_RATE,
  MAX_LOCAL_ASSET_DIMENSION,
  MAX_LOCAL_ASSET_PIXELS,
  MIN_AUDIO_SAMPLE_RATE,
} from "../../localAssets/limits.ts";
import {
  maxPayloadBytes,
  payloadKindOf,
  type AudioPayloadMetadata,
  type ImagePayloadMetadata,
  type PayloadMetadata,
} from "../../localAssets/readiness.ts";
import {
  parseLocalAssetRef,
  SHA256_HEX_PATTERN,
  type LocalAssetCategory,
  type LocalAssetRef,
} from "../../localAssets/refs.ts";
import {
  MAX_THUMBNAIL_BYTES,
  MAX_THUMBNAIL_DIMENSION,
  THUMBNAIL_MIME_TYPES,
} from "./constants.ts";

export type AssetRow = {label: string; originalFilename: string; createdAt: string}; // ISO 8601
export type ThumbnailRecord = {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
};
export type WaveformRecord = {peaksPerSecond: number; peaks: Uint8Array};

export type Decoded<T> =
  | {status: "present"; value: T}
  | {status: "absent"}
  | {status: "corrupt"; reason: string};

const absent = {status: "absent"} as const;
const corrupt = (reason: string): {status: "corrupt"; reason: string} => ({
  status: "corrupt",
  reason,
});
const present = <T>(value: T): Decoded<T> => ({status: "present", value});

const PAYLOAD_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/**
 * INV-11: redundant identity fields are tolerated only when they equal what the
 * key implies. They are never used to look anything up. Returns a reason when
 * the value contradicts its key.
 */
const checkAssetRowIdentity = (
  key: string,
  parsed: {category: string; digest: string},
  value: Record<string, unknown>,
): string | null => {
  if (value.ref !== undefined && value.ref !== key) {
    return "stored ref does not match its key";
  }

  if (value.category !== undefined && value.category !== parsed.category) {
    return "stored category does not match its key";
  }

  if (value.digest !== undefined && value.digest !== parsed.digest) {
    return "stored digest does not match its key";
  }

  return null;
};

/** Digest-keyed records: only the digest can be implied by the key. */
const checkDigestIdentity = (
  digest: string,
  value: Record<string, unknown>,
): string | null => {
  if (value.digest !== undefined && value.digest !== digest) {
    return "stored digest does not match its key";
  }

  if (value.ref !== undefined) {
    const parsed =
      typeof value.ref === "string" ? parseLocalAssetRef(value.ref) : null;

    if (parsed === null || parsed.digest !== digest) {
      return "stored ref does not match its key";
    }
  }

  if (value.category !== undefined) {
    return "stored category is not implied by its key";
  }

  return null;
};

export const decodeAssetRow = (
  key: LocalAssetRef,
  value: unknown,
): Decoded<AssetRow> => {
  if (value === undefined) {
    return absent;
  }

  const parsed = parseLocalAssetRef(key);

  if (parsed === null) {
    return corrupt("key is not a canonical local asset ref");
  }

  if (!isRecord(value)) {
    return corrupt("row is not an object");
  }

  const identityProblem = checkAssetRowIdentity(key, parsed, value);

  if (identityProblem !== null) {
    return corrupt(identityProblem);
  }

  if (typeof value.label !== "string") {
    return corrupt("label is not a string");
  }

  if (typeof value.originalFilename !== "string") {
    return corrupt("originalFilename is not a string");
  }

  if (typeof value.createdAt !== "string") {
    return corrupt("createdAt is not a string");
  }

  return present({
    label: value.label,
    originalFilename: value.originalFilename,
    createdAt: value.createdAt,
  });
};

const AUDIO_PAYLOAD_KEYS = [
  "byteSize",
  "channels",
  "codec",
  "container",
  "durationSeconds",
  "kind",
  "mimeType",
  "sampleRate",
];

const decodeAudioPayloadMeta = (
  value: Record<string, unknown>,
): Decoded<PayloadMetadata> => {
  const keys = Object.keys(value).sort();

  if (
    keys.length !== AUDIO_PAYLOAD_KEYS.length ||
    keys.some((key, index) => key !== AUDIO_PAYLOAD_KEYS[index])
  ) {
    return corrupt("audio payload metadata has unexpected fields");
  }

  const {mimeType, byteSize, container, codec, durationSeconds, sampleRate, channels} = value;

  if (
    typeof container !== "string" ||
    !(audioContainers as readonly string[]).includes(container)
  ) {
    return corrupt("unknown audio container");
  }

  if (typeof codec !== "string" || !(audioCodecs as readonly string[]).includes(codec)) {
    return corrupt("unknown audio codec");
  }

  if (!isAcceptedAudioCombination(container as AudioContainer, codec as AudioCodec)) {
    return corrupt("audio container and codec are not an accepted pair");
  }

  if (mimeType !== audioMimeTypeFor(container as AudioContainer)) {
    return corrupt("mimeType does not match the audio container");
  }

  if (!isPositiveInteger(byteSize) || byteSize > maxPayloadBytes("audio")) {
    return corrupt("byteSize is out of range");
  }

  if (
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > MAX_AUDIO_DURATION_SECONDS
  ) {
    return corrupt("durationSeconds is out of range");
  }

  if (
    typeof sampleRate !== "number" ||
    !Number.isInteger(sampleRate) ||
    sampleRate < MIN_AUDIO_SAMPLE_RATE ||
    sampleRate > MAX_AUDIO_SAMPLE_RATE
  ) {
    return corrupt("sampleRate is out of range");
  }

  if (channels !== 1 && channels !== 2) {
    return corrupt("channels must be 1 or 2");
  }

  const decoded: AudioPayloadMetadata = {
    kind: "audio",
    mimeType: mimeType as AudioPayloadMetadata["mimeType"],
    byteSize,
    container: container as AudioContainer,
    codec: codec as AudioCodec,
    durationSeconds,
    sampleRate,
    channels,
  };

  return present(decoded);
};

export const decodePayloadMeta = (
  digest: string,
  value: unknown,
): Decoded<PayloadMetadata> => {
  if (value === undefined) {
    return absent;
  }

  if (!SHA256_HEX_PATTERN.test(digest)) {
    return corrupt("key is not a sha256 digest");
  }

  if (!isRecord(value)) {
    return corrupt("payload metadata is not an object");
  }

  const identityProblem = checkDigestIdentity(digest, value);

  if (identityProblem !== null) {
    return corrupt(identityProblem);
  }

  if (value.kind === "audio") {
    return decodeAudioPayloadMeta(value);
  }

  if (value.kind !== undefined && value.kind !== "image") {
    return corrupt("unknown payload kind");
  }

  const {mimeType, byteSize, width, height} = value;

  if (typeof mimeType !== "string" || !PAYLOAD_MIME_TYPES.includes(mimeType)) {
    return corrupt("unknown mimeType");
  }

  if (!isPositiveInteger(byteSize) || byteSize > maxPayloadBytes("image")) {
    return corrupt("byteSize is out of range");
  }

  if (
    !isPositiveInteger(width) ||
    !isPositiveInteger(height) ||
    width > MAX_LOCAL_ASSET_DIMENSION ||
    height > MAX_LOCAL_ASSET_DIMENSION
  ) {
    return corrupt("width or height is out of range");
  }

  if (width * height > MAX_LOCAL_ASSET_PIXELS) {
    return corrupt("pixel count is out of range");
  }

  return present({
    mimeType: mimeType as ImagePayloadMetadata["mimeType"],
    byteSize,
    width,
    height,
  });
};

export const decodeBlobRecord = (
  digest: string,
  value: unknown,
): Decoded<Blob> => {
  if (value === undefined) {
    return absent;
  }

  if (!SHA256_HEX_PATTERN.test(digest)) {
    return corrupt("key is not a sha256 digest");
  }

  if (!isRecord(value)) {
    return corrupt("blob record is not an object");
  }

  const identityProblem = checkDigestIdentity(digest, value);

  if (identityProblem !== null) {
    return corrupt(identityProblem);
  }

  if (!(value.blob instanceof Blob)) {
    return corrupt("blob is not a Blob");
  }

  if (value.blob.size <= 0) {
    return corrupt("blob is empty");
  }

  return present(value.blob);
};

export const decodeThumbnail = (
  digest: string,
  value: unknown,
): Decoded<ThumbnailRecord> => {
  if (value === undefined) {
    return absent;
  }

  if (!SHA256_HEX_PATTERN.test(digest)) {
    return corrupt("key is not a sha256 digest");
  }

  if (!isRecord(value)) {
    return corrupt("thumbnail record is not an object");
  }

  const identityProblem = checkDigestIdentity(digest, value);

  if (identityProblem !== null) {
    return corrupt(identityProblem);
  }

  const {blob, mimeType, width, height} = value;

  if (!(blob instanceof Blob)) {
    return corrupt("blob is not a Blob");
  }

  if (
    typeof mimeType !== "string" ||
    !(THUMBNAIL_MIME_TYPES as readonly string[]).includes(mimeType)
  ) {
    return corrupt("unknown mimeType");
  }

  if (
    !isPositiveInteger(width) ||
    !isPositiveInteger(height) ||
    width > MAX_THUMBNAIL_DIMENSION ||
    height > MAX_THUMBNAIL_DIMENSION
  ) {
    return corrupt("thumbnail width or height is out of range");
  }

  if (blob.size <= 0 || blob.size > MAX_THUMBNAIL_BYTES) {
    return corrupt("thumbnail size is out of range");
  }

  return present({blob, mimeType, width, height});
};

/** The waveform store: the key is the only identity, so any extra key (even a matching `digest`) is invalid. */
export const decodeWaveform = (
  digest: string,
  value: unknown,
): Decoded<WaveformRecord> => {
  if (value === undefined) {
    return absent;
  }

  if (!SHA256_HEX_PATTERN.test(digest)) {
    return corrupt("key is not a sha256 digest");
  }

  if (!isRecord(value)) {
    return corrupt("waveform record is not an object");
  }

  const keys = Object.keys(value).sort();

  if (keys.length !== 2 || keys[0] !== "peaks" || keys[1] !== "peaksPerSecond") {
    return corrupt("waveform record has unexpected fields");
  }

  const {peaksPerSecond, peaks} = value;

  if (
    typeof peaksPerSecond !== "number" ||
    !Number.isFinite(peaksPerSecond) ||
    peaksPerSecond <= 0
  ) {
    return corrupt("peaksPerSecond is out of range");
  }

  if (
    !(peaks instanceof Uint8Array) ||
    peaks.length < 1 ||
    peaks.length > MAX_WAVEFORM_PEAKS
  ) {
    return corrupt("peaks is not a Uint8Array of 1 to MAX_WAVEFORM_PEAKS values");
  }

  return present({peaksPerSecond, peaks});
};

/** An audio row must point at audio metadata and an image row at image metadata. */
export const payloadMatchesCategory = (
  meta: PayloadMetadata,
  category: LocalAssetCategory,
): boolean => (payloadKindOf(meta) === "audio") === (category === "audio");
