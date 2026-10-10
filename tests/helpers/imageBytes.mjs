// Crafted image headers for local-asset tests (ASSET-002 and later specs).
//
// These builders produce *header-valid* byte sequences, not decodable images
// (except where noted). They exist to exercise the pure header inspector in
// src/localAssets/imageInspection.ts. For real decodable images use the files
// in tests/fixtures/local-assets/.
//
// Every builder returns a Uint8Array.

import {crc32, deflateSync} from "node:zlib";

const encoder = new TextEncoder();

const ascii = (text) => encoder.encode(text);

export const concatBytes = (...parts) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

export const truncate = (bytes, length) => bytes.slice(0, length);

const u32be = (value) =>
  new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);

const u16be = (value) => new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);

const u16le = (value) => new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);

const u24le = (value) =>
  new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]);

const u32le = (value) =>
  new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);

/* ------------------------------------------------------------------ PNG */

export const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export const pngChunk = (type, data = new Uint8Array(0)) => {
  const typeBytes = ascii(type);
  const crc = crc32(concatBytes(typeBytes, data)) >>> 0;
  return concatBytes(u32be(data.length), typeBytes, data, u32be(crc));
};

const pngIhdrData = (width, height) =>
  concatBytes(
    u32be(width),
    u32be(height),
    // bit depth 8, color type 6 (RGBA), compression 0, filter 0, interlace 0
    new Uint8Array([8, 6, 0, 0, 0]),
  );

/**
 * Header-valid PNG: signature, IHDR, optional acTL, IDAT, IEND.
 * Pixel data is a tiny deflate stream and does NOT match the declared size,
 * so the result is not decodable at large dimensions.
 *
 * @param {object} [options]
 * @param {number} [options.width=1]
 * @param {number} [options.height=1]
 * @param {"before-idat" | "after-idat"} [options.acTL] where to put an acTL chunk
 * @param {boolean} [options.idat=true] set false to omit IDAT (malformed)
 * @param {boolean} [options.iend=true]
 * @param {Array<{type: string, data?: Uint8Array}>} [options.extraChunksBeforeIdat]
 */
export const buildPng = ({
  width = 1,
  height = 1,
  acTL,
  idat = true,
  iend = true,
  extraChunksBeforeIdat = [],
} = {}) => {
  const acTLChunk = pngChunk("acTL", concatBytes(u32be(2), u32be(0)));
  const parts = [PNG_SIGNATURE, pngChunk("IHDR", pngIhdrData(width, height))];

  for (const chunk of extraChunksBeforeIdat) {
    parts.push(pngChunk(chunk.type, chunk.data));
  }

  if (acTL === "before-idat") {
    parts.push(acTLChunk);
  }

  if (idat) {
    parts.push(pngChunk("IDAT", deflateSync(new Uint8Array(1))));
  }

  if (acTL === "after-idat") {
    parts.push(acTLChunk);
  }

  if (iend) {
    parts.push(pngChunk("IEND"));
  }

  return concatBytes(...parts);
};

/** APNG: `acTL` before the first `IDAT`. */
export const buildApng = ({width = 1, height = 1} = {}) =>
  buildPng({width, height, acTL: "before-idat"});

/* ----------------------------------------------------------------- JPEG */

/** SOF markers the inspector must accept (C4, C8, CC are not SOF). */
export const JPEG_SOF_MARKERS = [
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
  0xcf,
];

const jpegSegment = (marker, payload) =>
  concatBytes(
    new Uint8Array([0xff, marker]),
    u16be(payload.length + 2),
    payload,
  );

/**
 * Header-valid JPEG: SOI, optional APP0/EXIF/fill/restart bytes, a SOF
 * segment, SOS, EOI. Scan data is empty so the result is not decodable.
 *
 * @param {object} [options]
 * @param {number} [options.width=1]
 * @param {number} [options.height=1]
 * @param {number} [options.sof=0xC0] SOF marker byte
 * @param {boolean} [options.sofSegment=true] set false to reach SOS without SOF (malformed)
 * @param {boolean} [options.app0=true] JFIF APP0 segment before SOF
 * @param {boolean} [options.exifOrientation] adds an APP1 Exif segment with orientation 6
 * @param {boolean} [options.fillBytes] extra 0xFF fill bytes before the SOF marker
 * @param {boolean} [options.restartMarker] a length-less RSTn marker before SOF
 * @param {boolean} [options.dhtBeforeSof] a C4 (DHT) segment before SOF, which must not be mistaken for SOF
 * @param {boolean} [options.eoi=true]
 */
export const buildJpeg = ({
  width = 1,
  height = 1,
  sof = 0xc0,
  sofSegment = true,
  app0 = true,
  exifOrientation = false,
  fillBytes = false,
  restartMarker = false,
  dhtBeforeSof = false,
  eoi = true,
} = {}) => {
  const parts = [new Uint8Array([0xff, 0xd8])];

  if (app0) {
    parts.push(
      jpegSegment(
        0xe0,
        concatBytes(
          ascii("JFIF\0"),
          new Uint8Array([1, 1, 0, 0, 1, 0, 1, 0, 0]),
        ),
      ),
    );
  }

  if (exifOrientation) {
    // TIFF little-endian, one IFD entry: Orientation (0x0112) = 6.
    const tiff = concatBytes(
      ascii("II"),
      u16le(42),
      u32le(8),
      u16le(1),
      u16le(0x0112),
      u16le(3),
      u32le(1),
      u16le(6),
      u16le(0),
      u32le(0),
    );
    parts.push(jpegSegment(0xe1, concatBytes(ascii("Exif\0\0"), tiff)));
  }

  if (restartMarker) {
    parts.push(new Uint8Array([0xff, 0xd0]));
  }

  if (fillBytes) {
    parts.push(new Uint8Array([0xff, 0xff, 0xff]));
  }

  if (dhtBeforeSof) {
    // Class/id byte, 16 code-length counts (all zero).
    parts.push(jpegSegment(0xc4, new Uint8Array(17)));
  }

  if (sofSegment) {
    parts.push(
      jpegSegment(
        sof,
        concatBytes(
          new Uint8Array([8]), // precision
          u16be(height),
          u16be(width),
          new Uint8Array([1, 1, 0x11, 0]), // one component
        ),
      ),
    );
  }

  parts.push(jpegSegment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0])));

  if (eoi) {
    parts.push(new Uint8Array([0xff, 0xd9]));
  }

  return concatBytes(...parts);
};

/* ----------------------------------------------------------------- WebP */

export const webpChunk = (type, data = new Uint8Array(0)) => {
  const padded =
    data.length % 2 === 0 ? data : concatBytes(data, new Uint8Array(1));
  return concatBytes(ascii(type), u32le(data.length), padded);
};

/** RIFF/WEBP container around already-built chunks. */
export const buildRiffWebp = (...chunks) => {
  const body = concatBytes(ascii("WEBP"), ...chunks);
  return concatBytes(ascii("RIFF"), u32le(body.length), body);
};

const vp8FrameData = (width, height) =>
  concatBytes(
    new Uint8Array([0x10, 0x02, 0x00]), // key-frame tag
    new Uint8Array([0x9d, 0x01, 0x2a]), // start code
    u16le(width & 0x3fff),
    u16le(height & 0x3fff),
    new Uint8Array(8), // filler "partition" bytes
  );

const vp8lData = (width, height) => {
  // 14 bits width-1, 14 bits height-1, 1 bit alpha, 3 bits version (0).
  const packed =
    (((width - 1) & 0x3fff) |
      (((height - 1) & 0x3fff) << 14) |
      (1 << 28)) >>>
    0;
  return concatBytes(new Uint8Array([0x2f]), u32le(packed), new Uint8Array(8));
};

/** Lossy WebP (`VP8 `). Width/height are stored as 14 bits (0 is allowed to craft malformed input). */
export const buildWebpVp8 = ({width = 1, height = 1} = {}) =>
  buildRiffWebp(webpChunk("VP8 ", vp8FrameData(width, height)));

/** Lossless WebP (`VP8L`). Stored as value-1, so 0 cannot be represented. */
export const buildWebpVp8l = ({width = 1, height = 1} = {}) =>
  buildRiffWebp(webpChunk("VP8L", vp8lData(width, height)));

/**
 * Extended WebP (`VP8X`) followed by optional animation chunks and a VP8L image chunk.
 *
 * @param {object} [options]
 * @param {number} [options.width=1] canvas width, 1..2^24
 * @param {number} [options.height=1]
 * @param {boolean} [options.animated=false] sets the animation flag (0x02)
 * @param {boolean} [options.animChunk=false] append an `ANIM` chunk (static flag)
 * @param {boolean} [options.anmfChunk=false] append an `ANMF` chunk (static flag)
 * @param {boolean} [options.imageChunk=true] append a VP8L image chunk
 */
export const buildWebpVp8x = ({
  width = 1,
  height = 1,
  animated = false,
  animChunk = false,
  anmfChunk = false,
  imageChunk = true,
} = {}) => {
  const flags = animated ? 0x02 : 0x00;
  const chunks = [
    webpChunk(
      "VP8X",
      concatBytes(
        new Uint8Array([flags, 0, 0, 0]),
        u24le(width - 1),
        u24le(height - 1),
      ),
    ),
  ];

  if (animChunk) {
    chunks.push(webpChunk("ANIM", new Uint8Array(6)));
  }

  if (anmfChunk) {
    chunks.push(webpChunk("ANMF", new Uint8Array(16)));
  }

  if (imageChunk) {
    chunks.push(webpChunk("VP8L", vp8lData(Math.min(width, 16384), Math.min(height, 16384))));
  }

  return buildRiffWebp(...chunks);
};

/** Animated WebP, flag form: VP8X with the animation bit set. */
export const buildAnimatedWebpFlag = ({width = 1, height = 1} = {}) =>
  buildWebpVp8x({width, height, animated: true});

/** Animated WebP, chunk form: VP8X without the flag but with `ANIM`/`ANMF`. */
export const buildAnimatedWebpChunks = ({width = 1, height = 1} = {}) =>
  buildWebpVp8x({width, height, animChunk: true, anmfChunk: true});

/** RIFF/WEBP whose first chunk has an unknown type (malformed). */
export const buildWebpUnknownFirstChunk = () =>
  buildRiffWebp(webpChunk("JUNK", new Uint8Array(10)));

/** VP8 chunk whose frame start code is wrong (malformed). */
export const buildWebpVp8BadStartCode = () => {
  const frame = vp8FrameData(10, 10);
  frame.set([0x00, 0x00, 0x00], 3);
  return buildRiffWebp(webpChunk("VP8 ", frame));
};

/** VP8L chunk whose signature byte is not 0x2F (malformed). */
export const buildWebpVp8lBadSignature = () => {
  const data = vp8lData(10, 10);
  data[0] = 0x00;
  return buildRiffWebp(webpChunk("VP8L", data));
};

/* ----------------------------------------------- Unsupported signatures */

export const buildGifSignature = () =>
  concatBytes(
    ascii("GIF89a"),
    u16le(1),
    u16le(1),
    new Uint8Array([0x00, 0x00, 0x00, 0x3b]),
  );

export const buildSvgBytes = () =>
  ascii(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  );

export const buildAvifSignature = () =>
  concatBytes(
    u32be(24),
    ascii("ftyp"),
    ascii("avif"),
    u32be(0),
    ascii("avif"),
    ascii("mif1"),
  );

export const buildBmpSignature = () =>
  concatBytes(ascii("BM"), new Uint8Array(52));

export const buildTextBytes = () => ascii("this is not an image\n");

/* ------------------------------------------------------ Generic helpers */

export const IMAGE_FORMATS = [
  "png",
  "jpeg",
  "webp-vp8",
  "webp-vp8l",
  "webp-vp8x",
];

/** Header for any supported format with the given dimensions. */
export const buildImageHeader = (format, width, height) => {
  switch (format) {
    case "png":
      return buildPng({width, height});
    case "jpeg":
      return buildJpeg({width, height});
    case "webp-vp8":
      return buildWebpVp8({width, height});
    case "webp-vp8l":
      return buildWebpVp8l({width, height});
    case "webp-vp8x":
      return buildWebpVp8x({width, height});
    default:
      throw new Error(`Unknown image format: ${format}`);
  }
};

/** Dimension cases around the INV-7 limits, valid for every format above. */
export const DIMENSION_CASES = {
  /** Exactly 8192 x 6103 = 49 995 776 pixels: accepted. */
  maxAccepted: {width: 8192, height: 6103},
  /** 8192 x 8192 side limit itself is OK for sides, but is 67 M pixels: too-many-pixels. */
  maxSides: {width: 8192, height: 8192},
  /** One pixel past the side limit: dimensions-too-large. */
  wide8193: {width: 8193, height: 16},
  tall8193: {width: 16, height: 8193},
  /** 7072 x 7072 = 50 013 184 pixels: too-many-pixels. */
  tooManyPixels: {width: 7072, height: 7072},
};

const detailCases = (cases) =>
  cases.map(([name, bytes]) => ({name, bytes}));

/** Right signature but truncated or inconsistent: all must be `malformed`. */
export const buildTruncatedCases = () => {
  const png = buildPng({width: 10, height: 10});
  const jpeg = buildJpeg({width: 10, height: 10});
  const vp8 = buildWebpVp8({width: 10, height: 10});
  const vp8l = buildWebpVp8l({width: 10, height: 10});
  const vp8x = buildWebpVp8x({width: 10, height: 10});

  return detailCases([
    ["png signature only", truncate(png, 8)],
    ["png cut inside IHDR length", truncate(png, 10)],
    ["png cut inside IHDR data", truncate(png, 20)],
    ["png IHDR only, no IDAT", truncate(png, 33)],
    ["png without IDAT chunk", buildPng({width: 10, height: 10, idat: false})],
    [
      "png first chunk is not IHDR",
      concatBytes(PNG_SIGNATURE, pngChunk("tEXt", new Uint8Array(13))),
    ],
    [
      "png IHDR length is not 13",
      concatBytes(PNG_SIGNATURE, pngChunk("IHDR", new Uint8Array(12))),
    ],
    ["jpeg SOI only", truncate(jpeg, 2)],
    ["jpeg cut inside APP0 length", truncate(jpeg, 5)],
    ["jpeg cut inside SOF", truncate(jpeg, jpeg.length - 20)],
    ["jpeg reaches SOS before SOF", buildJpeg({sofSegment: false})],
    ["jpeg reaches EOI before SOF", concatBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))],
    ["webp RIFF only", truncate(vp8, 4)],
    ["webp RIFF/WEBP without chunk", truncate(vp8, 12)],
    ["webp vp8 cut inside frame header", truncate(vp8, 24)],
    ["webp vp8 bad start code", buildWebpVp8BadStartCode()],
    ["webp vp8l cut after signature byte", truncate(vp8l, 21)],
    ["webp vp8l bad signature byte", buildWebpVp8lBadSignature()],
    ["webp vp8x cut inside canvas size", truncate(vp8x, 26)],
    ["webp unknown first chunk", buildWebpUnknownFirstChunk()],
  ]);
};

/** Right signature but a zero dimension: all must be `malformed`. */
export const buildZeroDimensionCases = () =>
  detailCases([
    ["png zero width", buildPng({width: 0, height: 10})],
    ["png zero height", buildPng({width: 10, height: 0})],
    ["jpeg zero width", buildJpeg({width: 0, height: 10})],
    ["jpeg zero height", buildJpeg({width: 10, height: 0})],
    ["webp vp8 zero width", buildWebpVp8({width: 0, height: 10})],
    ["webp vp8 zero height", buildWebpVp8({width: 10, height: 0})],
  ]);

/** Deterministic pseudo-random bytes (mulberry32) for no-throw fuzz loops. */
export const pseudoRandomBytes = (seed, length) => {
  let state = seed >>> 0;
  const out = new Uint8Array(length);

  for (let index = 0; index < length; index += 1) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[index] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }

  return out;
};
