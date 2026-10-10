import {
  MAX_LOCAL_ASSET_BYTES,
  MAX_LOCAL_ASSET_DIMENSION,
  MAX_LOCAL_ASSET_PIXELS,
} from "./limits.ts";

export type InspectedImage = {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
};

export type ImageRejection =
  | "empty"
  | "too-large" // > MAX_LOCAL_ASSET_BYTES
  | "unsupported-format" // not PNG/JPEG/WebP by signature (GIF, SVG, AVIF, BMP, text...)
  | "animated" // APNG or animated WebP
  | "dimensions-too-large" // width or height > MAX_LOCAL_ASSET_DIMENSION
  | "too-many-pixels" // width * height > MAX_LOCAL_ASSET_PIXELS
  | "malformed"; // right signature but truncated/inconsistent header, or 0 dimension

export type ImageInspectionResult =
  | {ok: true; image: InspectedImage}
  | {ok: false; reason: ImageRejection};

export const checkLocalAssetByteSize = (
  byteSize: number,
): {ok: true} | {ok: false; reason: "empty" | "too-large"} => {
  if (!(byteSize > 0)) {
    return {ok: false, reason: "empty"};
  }

  if (byteSize > MAX_LOCAL_ASSET_BYTES) {
    return {ok: false, reason: "too-large"};
  }

  return {ok: true};
};

// Internal parse outcome: dimensions are range-checked afterwards, once, for all formats.
type ParsedHeader =
  | {kind: "image"; mimeType: InspectedImage["mimeType"]; width: number; height: number}
  | {kind: "reject"; reason: "unsupported-format" | "animated" | "malformed"};

const MALFORMED: ParsedHeader = {kind: "reject", reason: "malformed"};
const ANIMATED: ParsedHeader = {kind: "reject", reason: "animated"};
const UNSUPPORTED: ParsedHeader = {kind: "reject", reason: "unsupported-format"};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const hasBytesAt = (bytes: Uint8Array, offset: number, expected: number[]) => {
  if (offset < 0 || offset + expected.length > bytes.length) {
    return false;
  }

  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected[index]) {
      return false;
    }
  }

  return true;
};

const asciiBytes = (text: string) =>
  Array.from(text, (character) => character.charCodeAt(0));

// Four-character tags are built once so inspection allocates nothing per call.
const TAG_IHDR = asciiBytes("IHDR");
const TAG_IDAT = asciiBytes("IDAT");
const TAG_ACTL = asciiBytes("acTL");
const TAG_RIFF = asciiBytes("RIFF");
const TAG_WEBP = asciiBytes("WEBP");
const TAG_VP8 = asciiBytes("VP8 ");
const TAG_VP8L = asciiBytes("VP8L");
const TAG_VP8X = asciiBytes("VP8X");
const TAG_ANIM = asciiBytes("ANIM");
const TAG_ANMF = asciiBytes("ANMF");

const hasTag = (bytes: Uint8Array, offset: number, tag: number[]) =>
  hasBytesAt(bytes, offset, tag);

// Callers must have verified that the read is within bounds.
const u16be = (bytes: Uint8Array, offset: number) =>
  (bytes[offset] << 8) | bytes[offset + 1];

const u16le = (bytes: Uint8Array, offset: number) =>
  bytes[offset] | (bytes[offset + 1] << 8);

const u24le = (bytes: Uint8Array, offset: number) =>
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);

// Multiplication (not shifts) keeps the result an unsigned 32-bit value.
const u32be = (bytes: Uint8Array, offset: number) =>
  bytes[offset] * 0x1000000 +
  ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);

const u32le = (bytes: Uint8Array, offset: number) =>
  bytes[offset + 3] * 0x1000000 +
  ((bytes[offset + 2] << 16) | (bytes[offset + 1] << 8) | bytes[offset]);

const image = (
  mimeType: InspectedImage["mimeType"],
  width: number,
  height: number,
): ParsedHeader =>
  width <= 0 || height <= 0
    ? MALFORMED
    : {kind: "image", mimeType, width, height};

/* ------------------------------------------------------------------ PNG */

const PNG_CHUNK_OVERHEAD = 12; // length (4) + type (4) + CRC (4)
const PNG_IHDR_END = 8 + PNG_CHUNK_OVERHEAD + 13; // 33

const parsePng = (bytes: Uint8Array): ParsedHeader => {
  // IHDR: length 13 at 8, type at 12, width at 16, height at 20.
  if (bytes.length < PNG_IHDR_END) {
    return MALFORMED;
  }

  if (u32be(bytes, 8) !== 13 || !hasTag(bytes, 12, TAG_IHDR)) {
    return MALFORMED;
  }

  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  let offset = PNG_IHDR_END;

  // Walk chunks until the first IDAT. Each step advances by at least 12 bytes.
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      return MALFORMED;
    }

    const length = u32be(bytes, offset);

    if (hasTag(bytes, offset + 4, TAG_ACTL)) {
      return ANIMATED;
    }

    const next = offset + PNG_CHUNK_OVERHEAD + length;

    // Every chunk, including the first IDAT, must fit entirely (header, data, CRC).
    if (next > bytes.length) {
      return MALFORMED;
    }

    if (hasTag(bytes, offset + 4, TAG_IDAT)) {
      return image("image/png", width, height);
    }

    offset = next;
  }

  return MALFORMED; // no IDAT before the end of data
};

/* ----------------------------------------------------------------- JPEG */

const isJpegSof = (marker: number) =>
  marker >= 0xc0 &&
  marker <= 0xcf &&
  marker !== 0xc4 &&
  marker !== 0xc8 &&
  marker !== 0xcc;

const parseJpeg = (bytes: Uint8Array): ParsedHeader => {
  let offset = 2; // after SOI

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return MALFORMED;
    }

    // Skip any number of 0xFF fill bytes.
    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }

    if (offset >= bytes.length) {
      return MALFORMED;
    }

    const marker = bytes[offset];
    offset += 1;

    if (marker === 0x00) {
      return MALFORMED;
    }

    if (marker === 0xd9 || marker === 0xda) {
      return MALFORMED; // EOI or SOS before any SOF
    }

    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      continue; // standalone markers carry no length
    }

    // `offset` now points at the 2-byte length, which includes itself.
    if (offset + 2 > bytes.length) {
      return MALFORMED;
    }

    const length = u16be(bytes, offset);

    if (length < 2 || offset + length > bytes.length) {
      return MALFORMED;
    }

    if (isJpegSof(marker)) {
      // length(2) precision(1) height(2) width(2)
      if (length < 7) {
        return MALFORMED;
      }

      return image("image/jpeg", u16be(bytes, offset + 5), u16be(bytes, offset + 3));
    }

    offset += length; // always >= 2
  }

  return MALFORMED;
};

/* ----------------------------------------------------------------- WebP */

const WEBP_CHUNK_HEADER = 8; // type (4) + size (4)
const WEBP_FIRST_CHUNK = 12;

// The declared chunk data must lie entirely within the RIFF body and the file. The pad byte of an
// odd-sized final chunk is not part of the data, so its absence is tolerated.
const webpChunkDataFits = (limit: number, dataStart: number, size: number) =>
  dataStart + size <= limit;

// The RIFF size may exceed the file by exactly one byte only when that byte is
// the missing pad of an odd-sized final chunk whose data ends at the file end.
const webpPadToleranceOk = (
  bytes: Uint8Array,
  riffEnd: number,
  lastDataEnd: number,
  lastSize: number,
) => riffEnd <= bytes.length || ((lastSize & 1) === 1 && lastDataEnd === bytes.length);

const parseWebp = (bytes: Uint8Array): ParsedHeader => {
  if (bytes.length < WEBP_FIRST_CHUNK) {
    return MALFORMED;
  }

  if (!hasTag(bytes, 8, TAG_WEBP)) {
    return UNSUPPORTED; // some other RIFF container
  }

  // The RIFF size counts everything after the first 8 bytes and must at least
  // cover "WEBP". A missing final pad byte is tolerated (riffEnd may be one past
  // the data); bytes after riffEnd are trailing data and are never inspected.
  const riffEnd = 8 + u32le(bytes, 4);

  if (riffEnd < WEBP_FIRST_CHUNK || riffEnd > bytes.length + 1) {
    return MALFORMED;
  }

  const limit = Math.min(riffEnd, bytes.length);

  if (limit < WEBP_FIRST_CHUNK + WEBP_CHUNK_HEADER) {
    return MALFORMED;
  }

  const dataStart = WEBP_FIRST_CHUNK + WEBP_CHUNK_HEADER;
  const size = u32le(bytes, WEBP_FIRST_CHUNK + 4);

  if (hasTag(bytes, WEBP_FIRST_CHUNK, TAG_VP8)) {
    // Frame tag (3) + start code (3) + width (2) + height (2).
    if (
      size < 10 ||
      !webpChunkDataFits(limit, dataStart, size) ||
      !webpPadToleranceOk(bytes, riffEnd, dataStart + size, size)
    ) {
      return MALFORMED;
    }

    if (!hasBytesAt(bytes, dataStart + 3, [0x9d, 0x01, 0x2a])) {
      return MALFORMED;
    }

    return image(
      "image/webp",
      u16le(bytes, dataStart + 6) & 0x3fff,
      u16le(bytes, dataStart + 8) & 0x3fff,
    );
  }

  if (hasTag(bytes, WEBP_FIRST_CHUNK, TAG_VP8L)) {
    // Signature (1) + packed width/height (4).
    if (
      size < 5 ||
      !webpChunkDataFits(limit, dataStart, size) ||
      !webpPadToleranceOk(bytes, riffEnd, dataStart + size, size) ||
      bytes[dataStart] !== 0x2f
    ) {
      return MALFORMED;
    }

    const packed = u32le(bytes, dataStart + 1);

    return image(
      "image/webp",
      (packed & 0x3fff) + 1,
      ((packed >>> 14) & 0x3fff) + 1,
    );
  }

  if (hasTag(bytes, WEBP_FIRST_CHUNK, TAG_VP8X)) {
    // Flags (1) + reserved (3) + canvas width-1 (3) + canvas height-1 (3).
    // The chunk is exactly 10 bytes; any other size is a damaged file, and it
    // would otherwise let the chunk scan below skip past (or hide) an ANIM chunk.
    if (size !== 10 || !webpChunkDataFits(limit, dataStart, size)) {
      return MALFORMED;
    }

    if ((bytes[dataStart] & 0x02) !== 0) {
      return ANIMATED;
    }

    const width = u24le(bytes, dataStart + 4) + 1;
    const height = u24le(bytes, dataStart + 7) + 1;

    // Scan the remaining top-level chunks for animation chunks. A chunk that
    // overruns the data means a damaged file: `malformed`. A missing final pad
    // byte is tolerated.
    let offset = dataStart + size;
    let lastDataEnd = dataStart + size;
    let lastSize = size;

    while (offset < limit) {
      if (offset + WEBP_CHUNK_HEADER > limit) {
        return MALFORMED;
      }

      if (hasTag(bytes, offset, TAG_ANIM) || hasTag(bytes, offset, TAG_ANMF)) {
        return ANIMATED;
      }

      const chunkSize = u32le(bytes, offset + 4);
      const chunkEnd = offset + WEBP_CHUNK_HEADER + chunkSize;

      if (chunkEnd > limit) {
        return MALFORMED;
      }

      lastDataEnd = chunkEnd;
      lastSize = chunkSize;
      offset = chunkEnd + (chunkSize & 1); // always advances by >= 8
    }

    if (!webpPadToleranceOk(bytes, riffEnd, lastDataEnd, lastSize)) {
      return MALFORMED;
    }

    return image("image/webp", width, height);
  }

  return MALFORMED;
};

/* --------------------------------------------------------------- public */

const parseHeader = (bytes: Uint8Array): ParsedHeader => {
  if (hasBytesAt(bytes, 0, PNG_SIGNATURE)) {
    return parsePng(bytes);
  }

  if (hasBytesAt(bytes, 0, [0xff, 0xd8])) {
    return parseJpeg(bytes);
  }

  if (hasTag(bytes, 0, TAG_RIFF)) {
    return parseWebp(bytes);
  }

  return UNSUPPORTED;
};

/**
 * Header-only inspection of a PNG, JPEG or WebP image. Format is detected
 * from bytes only (never a filename or MIME type). Never throws: any read past
 * the end of the data is `malformed`.
 */
export const inspectImageBytes = (bytes: Uint8Array): ImageInspectionResult => {
  const size = checkLocalAssetByteSize(bytes.length);

  if (!size.ok) {
    return size;
  }

  let parsed: ParsedHeader;

  try {
    parsed = parseHeader(bytes);
  } catch {
    // Defense in depth: the parsers are bounds-checked and should never throw.
    return {ok: false, reason: "malformed"};
  }

  if (parsed.kind === "reject") {
    return {ok: false, reason: parsed.reason};
  }

  if (
    parsed.width > MAX_LOCAL_ASSET_DIMENSION ||
    parsed.height > MAX_LOCAL_ASSET_DIMENSION
  ) {
    return {ok: false, reason: "dimensions-too-large"};
  }

  if (parsed.width * parsed.height > MAX_LOCAL_ASSET_PIXELS) {
    return {ok: false, reason: "too-many-pixels"};
  }

  return {
    ok: true,
    image: {mimeType: parsed.mimeType, width: parsed.width, height: parsed.height},
  };
};

export const describeImageRejection = (reason: ImageRejection): string => {
  switch (reason) {
    case "empty":
      return "The file is empty.";
    case "too-large":
      return "The file is larger than 25 MiB.";
    case "unsupported-format":
      return "Only static PNG, JPEG and WebP images are supported.";
    case "animated":
      return "Animated images are not supported.";
    case "dimensions-too-large":
      return `Images must be at most ${MAX_LOCAL_ASSET_DIMENSION} pixels wide and tall.`;
    case "too-many-pixels":
      return "Images must be at most 50 megapixels.";
    case "malformed":
      return "The image file is damaged or incomplete.";
  }
};
