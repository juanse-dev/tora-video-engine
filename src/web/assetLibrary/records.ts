import {
  MAX_LOCAL_ASSET_BYTES,
  MAX_LOCAL_ASSET_DIMENSION,
  MAX_LOCAL_ASSET_PIXELS,
} from "../../localAssets/limits.ts";
import type {PayloadMetadata} from "../../localAssets/readiness.ts";
import {
  parseLocalAssetRef,
  SHA256_HEX_PATTERN,
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

  const {mimeType, byteSize, width, height} = value;

  if (typeof mimeType !== "string" || !PAYLOAD_MIME_TYPES.includes(mimeType)) {
    return corrupt("unknown mimeType");
  }

  if (!isPositiveInteger(byteSize) || byteSize > MAX_LOCAL_ASSET_BYTES) {
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
    mimeType: mimeType as PayloadMetadata["mimeType"],
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
