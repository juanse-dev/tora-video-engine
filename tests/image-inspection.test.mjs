import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import {sha256Hex} from "../src/localAssets/hash.ts";
import {
  checkLocalAssetByteSize,
  describeImageRejection,
  inspectImageBytes,
} from "../src/localAssets/imageInspection.ts";
import {MAX_LOCAL_ASSET_BYTES} from "../src/localAssets/limits.ts";
import {
  DIMENSION_CASES,
  IMAGE_FORMATS,
  JPEG_SOF_MARKERS,
  PNG_SIGNATURE,
  buildAnimatedWebpChunks,
  buildAnimatedWebpFlag,
  buildApng,
  buildAvifSignature,
  buildBmpSignature,
  buildGifSignature,
  buildImageHeader,
  buildJpeg,
  buildPng,
  buildRiffWebp,
  buildSvgBytes,
  buildTextBytes,
  buildTruncatedCases,
  buildWebpVp8,
  buildWebpVp8l,
  buildWebpVp8x,
  buildZeroDimensionCases,
  concatBytes,
  pngChunk,
  pseudoRandomBytes,
  truncate,
  webpChunk,
} from "./helpers/imageBytes.mjs";

const fixtureUrl = (name) =>
  new URL(`./fixtures/local-assets/${name}`, import.meta.url);

const readFixture = async (name) => new Uint8Array(await readFile(fixtureUrl(name)));

const accepted = (bytes) => {
  const result = inspectImageBytes(bytes);
  assert.equal(result.ok, true, `expected accepted, got ${JSON.stringify(result)}`);
  return result.image;
};

const rejected = (bytes) => {
  const result = inspectImageBytes(bytes);
  assert.equal(result.ok, false, "expected rejection");
  return result.reason;
};

const u32be = (value) =>
  new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);

/* ----------------------------------------------------- byte size check */

test("checkLocalAssetByteSize accepts 1 byte and the 25 MiB maximum", () => {
  assert.deepEqual(checkLocalAssetByteSize(1), {ok: true});
  assert.deepEqual(checkLocalAssetByteSize(MAX_LOCAL_ASSET_BYTES), {ok: true});
});

test("checkLocalAssetByteSize rejects zero as empty and one over the maximum as too-large", () => {
  assert.deepEqual(checkLocalAssetByteSize(0), {ok: false, reason: "empty"});
  assert.deepEqual(checkLocalAssetByteSize(MAX_LOCAL_ASSET_BYTES + 1), {
    ok: false,
    reason: "too-large",
  });
});

/* -------------------------------------------------- accepted formats */

test("accepts a header-valid PNG with its dimensions", () => {
  assert.deepEqual(accepted(buildPng({width: 600, height: 900})), {
    mimeType: "image/png",
    width: 600,
    height: 900,
  });
});

test("accepts a PNG with ancillary chunks and an acTL chunk after IDAT", () => {
  const bytes = buildPng({
    width: 20,
    height: 30,
    acTL: "after-idat",
    extraChunksBeforeIdat: [{type: "tEXt", data: new Uint8Array(40)}],
  });
  assert.deepEqual(accepted(bytes), {mimeType: "image/png", width: 20, height: 30});
});

test("accepts a header-valid JPEG with its dimensions", () => {
  assert.deepEqual(accepted(buildJpeg({width: 1080, height: 1920})), {
    mimeType: "image/jpeg",
    width: 1080,
    height: 1920,
  });
});

for (const sof of JPEG_SOF_MARKERS) {
  test(`reads JPEG dimensions from SOF marker 0x${sof.toString(16)}`, () => {
    assert.deepEqual(accepted(buildJpeg({width: 321, height: 123, sof})), {
      mimeType: "image/jpeg",
      width: 321,
      height: 123,
    });
  });
}

test("skips JPEG fill bytes, restart markers, EXIF and DHT before SOF", () => {
  const bytes = buildJpeg({
    width: 640,
    height: 480,
    exifOrientation: true,
    restartMarker: true,
    fillBytes: true,
    dhtBeforeSof: true,
  });
  assert.deepEqual(accepted(bytes), {
    mimeType: "image/jpeg",
    width: 640,
    height: 480,
  });
});

test("JPEG dimensions are the raw stored size, ignoring EXIF orientation", () => {
  const image = accepted(
    buildJpeg({width: 1080, height: 1920, exifOrientation: true}),
  );
  assert.equal(image.width, 1080);
  assert.equal(image.height, 1920);
});

test("accepts lossy WebP (VP8) with 14-bit dimensions", () => {
  assert.deepEqual(accepted(buildWebpVp8({width: 321, height: 654})), {
    mimeType: "image/webp",
    width: 321,
    height: 654,
  });
});

test("accepts lossless WebP (VP8L) with value-minus-one dimensions", () => {
  assert.deepEqual(accepted(buildWebpVp8l({width: 321, height: 654})), {
    mimeType: "image/webp",
    width: 321,
    height: 654,
  });
  // The 14-bit maximum (16384) decodes as value + 1 and is then range-checked.
  assert.equal(
    rejected(buildWebpVp8l({width: 1, height: 16384})),
    "dimensions-too-large",
  );
});

test("accepts static extended WebP (VP8X) with 24-bit canvas dimensions", () => {
  assert.deepEqual(accepted(buildWebpVp8x({width: 777, height: 555})), {
    mimeType: "image/webp",
    width: 777,
    height: 555,
  });
});

test("accepts every supported format at every format-level boundary via buildImageHeader", () => {
  for (const format of IMAGE_FORMATS) {
    const image = accepted(buildImageHeader(format, 100, 200));
    assert.equal(image.width, 100, format);
    assert.equal(image.height, 200, format);
  }
});

/* ---------------------------------------------------------- fixtures */

test("accepts the real PNG fixture", async () => {
  assert.deepEqual(accepted(await readFixture("pose-magenta.png")), {
    mimeType: "image/png",
    width: 600,
    height: 900,
  });
});

test("accepts the real JPEG fixture", async () => {
  assert.deepEqual(accepted(await readFixture("background-cyan.jpg")), {
    mimeType: "image/jpeg",
    width: 1080,
    height: 1920,
  });
});

test("accepts the extensionless WebP fixture (inspection never looks at names)", async () => {
  assert.deepEqual(accepted(await readFixture("background-noext")), {
    mimeType: "image/webp",
    width: 1080,
    height: 1920,
  });
});

/* -------------------------------------------------------- size checks */

test("rejects empty input as empty", () => {
  assert.equal(rejected(new Uint8Array(0)), "empty");
});

test("rejects MAX_LOCAL_ASSET_BYTES + 1 as too-large before parsing", () => {
  assert.equal(rejected(new Uint8Array(MAX_LOCAL_ASSET_BYTES + 1)), "too-large");
});

test("a valid PNG padded to exactly MAX_LOCAL_ASSET_BYTES is not too-large", () => {
  const png = buildPng({width: 4, height: 4});
  const padded = new Uint8Array(MAX_LOCAL_ASSET_BYTES);
  padded.set(png);
  assert.deepEqual(accepted(padded), {mimeType: "image/png", width: 4, height: 4});
});

/* ------------------------------------------------- unsupported formats */

test("rejects GIF, SVG, AVIF, BMP and text as unsupported-format", () => {
  assert.equal(rejected(buildGifSignature()), "unsupported-format");
  assert.equal(rejected(buildSvgBytes()), "unsupported-format");
  assert.equal(rejected(buildAvifSignature()), "unsupported-format");
  assert.equal(rejected(buildBmpSignature()), "unsupported-format");
  assert.equal(rejected(buildTextBytes()), "unsupported-format");
});

test("RIFF containers that are not WebP are unsupported-format", () => {
  const wave = concatBytes(
    new TextEncoder().encode("RIFF"),
    new Uint8Array([4, 0, 0, 0]),
    new TextEncoder().encode("WAVE"),
    new Uint8Array(16),
  );
  assert.equal(rejected(wave), "unsupported-format");
});

test("a single byte that is not a signature is unsupported-format", () => {
  assert.equal(rejected(new Uint8Array([0x00])), "unsupported-format");
});

/* ---------------------------------------------------------- animated */

test("rejects APNG (acTL before IDAT) as animated", () => {
  assert.equal(rejected(buildApng({width: 10, height: 10})), "animated");
});

test("rejects animated WebP, flag form, as animated", () => {
  assert.equal(rejected(buildAnimatedWebpFlag({width: 10, height: 10})), "animated");
});

test("rejects animated WebP, ANIM/ANMF chunk form, as animated", () => {
  assert.equal(rejected(buildAnimatedWebpChunks({width: 10, height: 10})), "animated");
  assert.equal(
    rejected(buildWebpVp8x({width: 10, height: 10, animChunk: true})),
    "animated",
  );
  assert.equal(
    rejected(buildWebpVp8x({width: 10, height: 10, anmfChunk: true})),
    "animated",
  );
});

test("animation chunk found before a later overrun is animated, not malformed", () => {
  const vp8x = buildWebpVp8x({width: 10, height: 10, imageChunk: false, animChunk: true});
  const overrun = concatBytes(
    vp8x,
    new TextEncoder().encode("JUNK"),
    new Uint8Array([0xff, 0xff, 0xff, 0x7f]),
  );
  assert.equal(rejected(overrun), "animated");
});

/* -------------------------------------------------------- dimensions */

for (const format of IMAGE_FORMATS) {
  test(`${format}: exactly 8192x6103 (49 995 776 px) is accepted`, () => {
    const {width, height} = DIMENSION_CASES.maxAccepted;
    assert.deepEqual(accepted(buildImageHeader(format, width, height)).width, width);
  });

  test(`${format}: a side of 8193 px is dimensions-too-large`, () => {
    const {wide8193, tall8193} = DIMENSION_CASES;
    assert.equal(
      rejected(buildImageHeader(format, wide8193.width, wide8193.height)),
      "dimensions-too-large",
    );
    assert.equal(
      rejected(buildImageHeader(format, tall8193.width, tall8193.height)),
      "dimensions-too-large",
    );
  });

  test(`${format}: 7072x7072 (50 013 184 px) is too-many-pixels`, () => {
    const {width, height} = DIMENSION_CASES.tooManyPixels;
    assert.equal(rejected(buildImageHeader(format, width, height)), "too-many-pixels");
  });

  test(`${format}: 8192x8192 passes the side limit but is too-many-pixels`, () => {
    const {width, height} = DIMENSION_CASES.maxSides;
    assert.equal(rejected(buildImageHeader(format, width, height)), "too-many-pixels");
  });
}

test("a 24-bit VP8X canvas far beyond the side limit is dimensions-too-large", () => {
  assert.equal(
    rejected(buildWebpVp8x({width: 16_777_216, height: 16_777_216})),
    "dimensions-too-large",
  );
});

test("a 32-bit PNG width is dimensions-too-large and does not overflow", () => {
  const ihdr = concatBytes(
    u32be(0xffffffff),
    u32be(0xffffffff),
    new Uint8Array([8, 6, 0, 0, 0]),
  );
  const bytes = concatBytes(
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(2)),
    pngChunk("IEND"),
  );
  assert.equal(rejected(bytes), "dimensions-too-large");
});

/* --------------------------------------------------------- malformed */

for (const {name, bytes} of buildTruncatedCases()) {
  test(`malformed: ${name}`, () => {
    assert.equal(rejected(bytes), "malformed");
  });
}

for (const {name, bytes} of buildZeroDimensionCases()) {
  test(`malformed: ${name}`, () => {
    assert.equal(rejected(bytes), "malformed");
  });
}

test("the smallest representable VP8L and VP8X canvases (1x1) are accepted", () => {
  // value-1 encodings cannot express 0; the minimum is 1x1 and must be accepted.
  assert.deepEqual(accepted(buildWebpVp8l({width: 1, height: 1})).width, 1);
  assert.deepEqual(accepted(buildWebpVp8x({width: 1, height: 1})).height, 1);
});

test("malformed: png chunk length runs past the end before IDAT", () => {
  const ihdr = buildPng({width: 10, height: 10, idat: false, iend: false});
  const bytes = concatBytes(
    ihdr,
    u32be(1000),
    new TextEncoder().encode("tEXt"),
    new Uint8Array(10),
  );
  assert.equal(rejected(bytes), "malformed");
});

test("malformed: png chunk length of 0xFFFFFFFF before IDAT does not overflow or loop", () => {
  const ihdr = buildPng({width: 10, height: 10, idat: false, iend: false});
  const bytes = concatBytes(
    ihdr,
    u32be(0xffffffff),
    new TextEncoder().encode("tEXt"),
    new Uint8Array(4),
  );
  assert.equal(rejected(bytes), "malformed");
});

test("malformed: png with a partial chunk header after IHDR", () => {
  const ihdr = buildPng({width: 10, height: 10, idat: false, iend: false});
  assert.equal(rejected(concatBytes(ihdr, new Uint8Array([0, 0, 0]))), "malformed");
});

// WebP first-chunk size field is a little-endian u32 at offset 16.
const withWebpFirstChunkSize = (bytes, size) => {
  const out = bytes.slice();
  new DataView(out.buffer).setUint32(16, size, true);
  return out;
};

for (const [name, build] of [
  ["VP8", () => buildWebpVp8({width: 10, height: 10})],
  ["VP8L", () => buildWebpVp8l({width: 10, height: 10})],
]) {
  test(`malformed: ${name} chunk declares more bytes than remain`, () => {
    const bytes = build();
    assert.equal(rejected(withWebpFirstChunkSize(bytes, bytes.length)), "malformed");
    assert.equal(rejected(withWebpFirstChunkSize(bytes, 0xffffffff)), "malformed");
  });

  test(`malformed: ${name} chunk data cut short`, () => {
    const bytes = build();
    // Remove 2 bytes: the pad byte (if any) and at least one data byte.
    assert.equal(rejected(truncate(bytes, bytes.length - 2)), "malformed");
  });
}

test("accepted: VP8 chunk with an odd declared size and the final pad byte missing (R6)", () => {
  const vp8 = buildWebpVp8({width: 10, height: 10});
  const data = concatBytes(vp8.slice(20), new Uint8Array(1)); // 19 bytes: odd
  const padded = buildRiffWebp(webpChunk("VP8 ", data));
  assert.equal(padded.length, 20 + 20);
  assert.deepEqual(accepted(truncate(padded, padded.length - 1)), {
    mimeType: "image/webp",
    width: 10,
    height: 10,
  });
});

test("accepted: VP8L chunk with an odd declared size and the final pad byte missing (R6)", () => {
  const vp8l = buildWebpVp8l({width: 10, height: 10});
  assert.deepEqual(accepted(truncate(vp8l, vp8l.length - 1)), {
    mimeType: "image/webp",
    width: 10,
    height: 10,
  });
});

test("malformed: VP8X file whose image chunk is truncated (covered by the trailing-chunk scan)", () => {
  const vp8x = buildWebpVp8x({width: 10, height: 10});
  assert.equal(rejected(truncate(vp8x, vp8x.length - 3)), "malformed");
  const vp8Image = buildRiffWebp(
    webpChunk("VP8X", concatBytes(new Uint8Array(4), new Uint8Array(6))),
    webpChunk("VP8 ", new Uint8Array(18)),
  );
  assert.equal(rejected(truncate(vp8Image, vp8Image.length - 4)), "malformed");
});

/* ------------------------------------------------- WebP RIFF size bound */

// RIFF size is a little-endian u32 at offset 4 (body length after the first 8 bytes).
const withRiffSize = (bytes, size) => {
  const out = bytes.slice();
  new DataView(out.buffer).setUint32(4, size, true);
  return out;
};

// Rewrite the RIFF size so the whole array is the declared body (plus `extra`
// for a physically missing final pad byte).
const withConsistentRiff = (bytes, extra = 0) => withRiffSize(bytes, bytes.length - 8 + extra);

const riffSizeOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);

test("the WebP builders write a RIFF size consistent with their length", () => {
  for (const bytes of [
    buildWebpVp8({width: 3, height: 4}),
    buildWebpVp8l({width: 3, height: 4}),
    buildWebpVp8x({width: 3, height: 4}),
    buildWebpVp8x({width: 3, height: 4, animChunk: true}),
  ]) {
    assert.equal(riffSizeOf(bytes) + 8, bytes.length);
  }
});

for (const [name, build] of [
  ["VP8", () => buildWebpVp8({width: 10, height: 10})],
  ["VP8L", () => buildWebpVp8l({width: 10, height: 10})],
  ["VP8X", () => buildWebpVp8x({width: 10, height: 10})],
]) {
  test(`malformed: ${name} RIFF size 0xFFFFFFFF with a physically complete file`, () => {
    assert.equal(rejected(withRiffSize(build(), 0xffffffff)), "malformed");
  });

  test(`malformed: ${name} RIFF size larger than the file by more than a pad byte`, () => {
    const bytes = build();
    assert.equal(rejected(withRiffSize(bytes, bytes.length - 8 + 2)), "malformed");
  });

  test(`accepted: ${name} with trailing garbage after the declared RIFF end`, () => {
    const bytes = build();
    const dims = accepted(bytes);
    assert.deepEqual(
      accepted(concatBytes(bytes, pseudoRandomBytes(7, 40))),
      dims,
    );
  });
}

test("malformed: WebP RIFF size below 4 cannot even contain WEBP", () => {
  for (const size of [0, 1, 3]) {
    assert.equal(
      rejected(withRiffSize(buildWebpVp8({width: 10, height: 10}), size)),
      "malformed",
      `riff size ${size}`,
    );
  }
});

test("accepted: WebP RIFF size matching exactly, or one more than the file (missing pad byte)", () => {
  const vp8l = buildWebpVp8l({width: 10, height: 10}); // odd chunk data, padded
  assert.deepEqual(accepted(vp8l), {mimeType: "image/webp", width: 10, height: 10});
  // Pad byte physically missing, RIFF size still counts it: riffEnd = length + 1.
  assert.deepEqual(accepted(truncate(vp8l, vp8l.length - 1)), {
    mimeType: "image/webp",
    width: 10,
    height: 10,
  });
});

test("RIFF but not WEBP stays unsupported-format even with a bogus RIFF size", () => {
  const wave = concatBytes(
    new TextEncoder().encode("RIFF"),
    new Uint8Array([0xff, 0xff, 0xff, 0xff]),
    new TextEncoder().encode("WAVE"),
    new Uint8Array(20),
  );
  assert.equal(rejected(wave), "unsupported-format");
});

test("an ANIM chunk beyond the declared RIFF end is trailing data: ignored, not animated", () => {
  const bytes = buildWebpVp8x({width: 10, height: 10});
  const withTrailingAnim = concatBytes(bytes, webpChunk("ANIM", new Uint8Array(6)));
  assert.deepEqual(accepted(withTrailingAnim), {
    mimeType: "image/webp",
    width: 10,
    height: 10,
  });
});

test("an ANIM chunk inside the declared RIFF end is still animated", () => {
  assert.equal(
    rejected(buildWebpVp8x({width: 10, height: 10, animChunk: true})),
    "animated",
  );
});

test("malformed: a WebP chunk that straddles the declared RIFF end", () => {
  const vp8x = buildWebpVp8x({width: 10, height: 10, imageChunk: false});
  const bytes = concatBytes(vp8x, webpChunk("EXIF", new Uint8Array(8)));
  // Declare the body to end 4 bytes into the EXIF chunk's data; the file stays complete.
  assert.equal(rejected(withRiffSize(bytes, vp8x.length - 8 + 8 + 4)), "malformed");
  // First-chunk (VP8) data running past the declared end.
  const vp8 = buildWebpVp8({width: 10, height: 10});
  assert.equal(rejected(withRiffSize(vp8, vp8.length - 8 - 4)), "malformed");
});

const pngBeforeIdat = () =>
  buildPng({width: 10, height: 10, idat: false, iend: false});

test("malformed: png truncated right after the IDAT chunk header", () => {
  const bytes = concatBytes(
    pngBeforeIdat(),
    u32be(20),
    new TextEncoder().encode("IDAT"),
  );
  assert.equal(rejected(bytes), "malformed");
});

test("malformed: png whose IDAT length exceeds the remaining bytes", () => {
  const bytes = concatBytes(
    pngBeforeIdat(),
    u32be(1000),
    new TextEncoder().encode("IDAT"),
    new Uint8Array(10),
  );
  assert.equal(rejected(bytes), "malformed");
});

test("malformed: png whose IDAT is missing its CRC", () => {
  const full = concatBytes(pngBeforeIdat(), pngChunk("IDAT", new Uint8Array(5)));
  assert.equal(rejected(truncate(full, full.length - 1)), "malformed");
});

test("accepted: png with a complete IDAT but no IEND (trailing chunks are not inspected)", () => {
  const bytes = concatBytes(pngBeforeIdat(), pngChunk("IDAT", new Uint8Array(5)));
  assert.deepEqual(accepted(bytes), {mimeType: "image/png", width: 10, height: 10});
});

test("malformed: jpeg segment with length 0 or 1 terminates as malformed", () => {
  for (const length of [0, 1]) {
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, length, 0x00, 0x00, 0x00, 0x00,
    ]);
    assert.equal(rejected(bytes), "malformed", `length ${length}`);
  }
});

test("malformed: jpeg segment length that runs past the end", () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00]);
  assert.equal(rejected(bytes), "malformed");
});

test("malformed: jpeg marker with no following bytes", () => {
  assert.equal(rejected(new Uint8Array([0xff, 0xd8, 0xff])), "malformed");
  assert.equal(rejected(new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xff])), "malformed");
});

test("malformed: jpeg with a non-marker byte where a marker is expected", () => {
  assert.equal(rejected(new Uint8Array([0xff, 0xd8, 0x12, 0x34, 0x56])), "malformed");
});

test("malformed: jpeg SOF segment too short to contain dimensions", () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x04, 0x08, 0x00]);
  assert.equal(rejected(bytes), "malformed");
});

test("malformed: jpeg with a very long run of restart markers and no SOF", () => {
  const body = new Uint8Array(1000);
  for (let index = 0; index < body.length; index += 2) {
    body[index] = 0xff;
    body[index + 1] = 0xd0;
  }
  assert.equal(rejected(concatBytes(new Uint8Array([0xff, 0xd8]), body)), "malformed");
});

test("malformed: static VP8X whose trailing chunk size runs past the end of data", () => {
  // Decision: a trailing chunk that overruns the data is a damaged file, so
  // the whole image is `malformed` (not accepted on the strength of the VP8X header).
  const vp8x = buildWebpVp8x({width: 10, height: 10, imageChunk: false});
  const bytes = concatBytes(
    vp8x,
    new TextEncoder().encode("EXIF"),
    new Uint8Array([0xff, 0xff, 0xff, 0x7f]),
    new Uint8Array(4),
  );
  assert.equal(rejected(withConsistentRiff(bytes)), "malformed");
});

test("malformed: static VP8X with a partial trailing chunk header", () => {
  const vp8x = buildWebpVp8x({width: 10, height: 10, imageChunk: false});
  assert.equal(
    rejected(withConsistentRiff(concatBytes(vp8x, new Uint8Array([1, 2, 3])))),
    "malformed",
  );
});

test("static VP8X with a final odd-sized chunk missing its pad byte is accepted", () => {
  const vp8x = buildWebpVp8x({width: 10, height: 10, imageChunk: false});
  const odd = webpChunk("EXIF", new Uint8Array(3));
  const bytes = withConsistentRiff(
    truncate(concatBytes(vp8x, odd), vp8x.length + odd.length - 1),
    1,
  );
  assert.deepEqual(accepted(bytes), {mimeType: "image/webp", width: 10, height: 10});
});

test("static VP8X with ICCP, EXIF and XMP metadata chunks is accepted", () => {
  const bytes = withConsistentRiff(concatBytes(
    buildWebpVp8x({width: 64, height: 32, imageChunk: false}),
    webpChunk("ICCP", new Uint8Array(33)),
    webpChunk("VP8L", concatBytes(new Uint8Array([0x2f]), new Uint8Array(12))),
    webpChunk("EXIF", new Uint8Array(8)),
    webpChunk("XMP ", new Uint8Array(5)),
  ));
  assert.deepEqual(accepted(bytes), {mimeType: "image/webp", width: 64, height: 32});
});

/** A VP8X chunk with an arbitrary declared size around a 10-byte payload. */
const buildVp8xWithDeclaredSize = (declaredSize, ...trailing) => {
  const header = concatBytes(
    new TextEncoder().encode("VP8X"),
    new Uint8Array([
      declaredSize & 0xff,
      (declaredSize >>> 8) & 0xff,
      (declaredSize >>> 16) & 0xff,
      (declaredSize >>> 24) & 0xff,
    ]),
    new Uint8Array([0, 0, 0, 0, 9, 0, 0, 9, 0, 0]), // flags, reserved, 10x10 canvas
  );
  const body = concatBytes(new TextEncoder().encode("WEBP"), header, ...trailing);

  return concatBytes(
    new TextEncoder().encode("RIFF"),
    new Uint8Array([body.length & 0xff, (body.length >>> 8) & 0xff, 0, 0]),
    body,
  );
};

test("malformed: VP8X chunk size 0xFFFFFFFF cannot hide an ANIM chunk behind it", () => {
  const bytes = buildVp8xWithDeclaredSize(
    0xffffffff,
    webpChunk("ANIM", new Uint8Array(6)),
  );
  assert.equal(rejected(bytes), "malformed");
});

test("malformed: VP8X chunk size 11 (anything but exactly 10)", () => {
  const bytes = buildVp8xWithDeclaredSize(
    11,
    new Uint8Array(2), // the 11th payload byte and its pad byte
    webpChunk("VP8L", concatBytes(new Uint8Array([0x2f]), new Uint8Array(12))),
  );
  assert.equal(rejected(bytes), "malformed");
});

test("VP8X chunk size exactly 10 is accepted", () => {
  const bytes = buildVp8xWithDeclaredSize(
    10,
    webpChunk("VP8L", concatBytes(new Uint8Array([0x2f]), new Uint8Array(12))),
  );
  assert.deepEqual(accepted(bytes), {mimeType: "image/webp", width: 10, height: 10});
});

test("malformed: webp chunk too small for its frame header", () => {
  const tinyVp8 = concatBytes(
    new TextEncoder().encode("RIFF"),
    new Uint8Array([0, 0, 0, 0]),
    new TextEncoder().encode("WEBP"),
    webpChunk("VP8 ", new Uint8Array(2)),
    new Uint8Array(40),
  );
  assert.equal(rejected(tinyVp8), "malformed");
});

/* --------------------------------------------------------- no-throw */

test("never throws for 0-64 byte pseudo-random inputs", () => {
  for (let seed = 1; seed <= 400; seed += 1) {
    const bytes = pseudoRandomBytes(seed, seed % 65);
    const result = inspectImageBytes(bytes);
    assert.equal(typeof result.ok, "boolean");

    if (result.ok === false) {
      assert.equal(typeof result.reason, "string");
    }
  }
});

test("never throws for random bytes behind each valid signature", () => {
  const signatures = [
    PNG_SIGNATURE,
    new Uint8Array([0xff, 0xd8]),
    concatBytes(
      new TextEncoder().encode("RIFF"),
      new Uint8Array(4),
      new TextEncoder().encode("WEBP"),
    ),
  ];
  const extra = [
    new TextEncoder().encode("VP8 "),
    new TextEncoder().encode("VP8L"),
    new TextEncoder().encode("VP8X"),
    new TextEncoder().encode("IHDR"),
  ];

  for (const signature of signatures) {
    for (let seed = 1; seed <= 300; seed += 1) {
      const tail = pseudoRandomBytes(seed, seed % 80);
      const prefix = extra[seed % extra.length];
      inspectImageBytes(concatBytes(signature, tail));
      inspectImageBytes(concatBytes(signature, prefix, tail));
    }
  }
});

test("never throws for any prefix of a valid image", () => {
  const samples = [
    buildPng({width: 10, height: 10}),
    buildJpeg({width: 10, height: 10, exifOrientation: true, dhtBeforeSof: true}),
    buildWebpVp8({width: 10, height: 10}),
    buildWebpVp8l({width: 10, height: 10}),
    buildWebpVp8x({width: 10, height: 10, animChunk: true}),
  ];

  for (const sample of samples) {
    for (let length = 0; length <= sample.length; length += 1) {
      const result = inspectImageBytes(truncate(sample, length));
      assert.equal(typeof result.ok, "boolean");
    }
  }
});

test("inspection honors a Uint8Array view with a non-zero byteOffset", () => {
  const png = buildPng({width: 12, height: 34});
  const backing = new Uint8Array(png.length + 10);
  backing.set(png, 7);
  assert.deepEqual(accepted(backing.subarray(7, 7 + png.length)), {
    mimeType: "image/png",
    width: 12,
    height: 34,
  });
});

/* ------------------------------------------------------ descriptions */

test("describeImageRejection gives a user-facing sentence for every reason", () => {
  assert.deepEqual(
    {
      empty: describeImageRejection("empty"),
      tooLarge: describeImageRejection("too-large"),
      unsupported: describeImageRejection("unsupported-format"),
      animated: describeImageRejection("animated"),
      dimensions: describeImageRejection("dimensions-too-large"),
      pixels: describeImageRejection("too-many-pixels"),
      malformed: describeImageRejection("malformed"),
    },
    {
      empty: "The file is empty.",
      tooLarge: "The file is larger than 25 MiB.",
      unsupported: "Only static PNG, JPEG and WebP images are supported.",
      animated: "Animated images are not supported.",
      dimensions: "Images must be at most 8192 pixels wide and tall.",
      pixels: "Images must be at most 50 megapixels.",
      malformed: "The image file is damaged or incomplete.",
    },
  );
});

/* ------------------------------------------------------------ hashing */

test("sha256Hex of 'abc' matches the known vector", async () => {
  assert.equal(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("sha256Hex of empty input is the empty-string digest, as 64 lowercase hex chars", async () => {
  const digest = await sha256Hex(new Uint8Array(0));
  assert.equal(
    digest,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.match(digest, /^[0-9a-f]{64}$/);
});

for (const name of ["pose-magenta.png", "background-cyan.jpg", "background-noext"]) {
  test(`sha256Hex of fixture ${name} equals node:crypto`, async () => {
    const bytes = await readFixture(name);
    assert.equal(
      await sha256Hex(bytes),
      createHash("sha256").update(bytes).digest("hex"),
    );
  });
}

test("sha256Hex hashes only the view's bytes, not the whole backing buffer", async () => {
  const backing = new Uint8Array([9, 9, 9, 0x61, 0x62, 0x63, 9, 9]);
  assert.equal(
    await sha256Hex(backing.subarray(3, 6)),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("sha256Hex uses an injected SubtleCrypto", async () => {
  const seen = [];
  const subtle = {
    digest: async (algorithm, data) => {
      seen.push([algorithm, data.byteLength]);
      return new Uint8Array(32).fill(0xab).buffer;
    },
  };
  assert.equal(
    await sha256Hex(new Uint8Array(5), subtle),
    "ab".repeat(32),
  );
  assert.deepEqual(seen, [["SHA-256", 5]]);
});
