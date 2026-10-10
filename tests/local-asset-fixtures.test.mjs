import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import {
  buildApng,
  buildAvifSignature,
  buildBmpSignature,
  buildGifSignature,
  buildJpeg,
  buildPng,
  buildSvgBytes,
  buildWebpVp8,
  buildWebpVp8l,
  buildWebpVp8x,
  buildTruncatedCases,
  buildZeroDimensionCases,
  pseudoRandomBytes,
  truncate,
} from "./helpers/imageBytes.mjs";

const fixtureUrl = (name) =>
  new URL(`./fixtures/local-assets/${name}`, import.meta.url);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const ascii = (bytes, start, end) =>
  String.fromCharCode(...bytes.subarray(start, end));

const u32be = (bytes, offset) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
  );

const u32le = (bytes, offset) =>
  (bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>>
  0;

const u16le = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);

const u24le = (bytes, offset) =>
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);

test("real fixtures exist with the expected signatures", async () => {
  const png = new Uint8Array(await readFile(fixtureUrl("pose-magenta.png")));
  assert.deepEqual([...png.subarray(0, 8)], PNG_SIGNATURE);
  assert.equal(ascii(png, 12, 16), "IHDR");
  assert.equal(u32be(png, 16), 600);
  assert.equal(u32be(png, 20), 900);
  assert.equal(png[24], 8, "bit depth");
  assert.equal(png[25], 6, "color type RGBA");

  const jpeg = new Uint8Array(await readFile(fixtureUrl("background-cyan.jpg")));
  assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.deepEqual([...jpeg.subarray(jpeg.length - 2)], [0xff, 0xd9]);

  const webp = new Uint8Array(await readFile(fixtureUrl("background-noext")));
  assert.equal(ascii(webp, 0, 4), "RIFF");
  assert.equal(ascii(webp, 8, 12), "WEBP");
  assert.equal(webp.length, u32le(webp, 4) + 8, "RIFF size");
});

test("builders return Uint8Array with signatures and declared dimensions", () => {
  const png = buildPng({width: 123, height: 45});
  assert.ok(png instanceof Uint8Array);
  assert.deepEqual([...png.subarray(0, 8)], PNG_SIGNATURE);
  assert.equal(ascii(png, 12, 16), "IHDR");
  assert.equal(u32be(png, 16), 123);
  assert.equal(u32be(png, 20), 45);

  const apng = buildApng({width: 10, height: 20});
  assert.ok(apng instanceof Uint8Array);
  assert.ok(ascii(apng, 0, apng.length).includes("acTL"));
  assert.ok(ascii(apng, 0, apng.length).includes("IDAT"));
  assert.ok(!ascii(buildPng({width: 1, height: 1}), 0, 200).includes("acTL"));

  const jpeg = buildJpeg({width: 300, height: 200});
  assert.ok(jpeg instanceof Uint8Array);
  assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8]);
  const sof = jpeg.findIndex(
    (byte, index) => byte === 0xff && jpeg[index + 1] === 0xc0,
  );
  assert.ok(sof > 0);
  assert.equal((jpeg[sof + 5] << 8) | jpeg[sof + 6], 200, "height");
  assert.equal((jpeg[sof + 7] << 8) | jpeg[sof + 8], 300, "width");

  const vp8 = buildWebpVp8({width: 321, height: 123});
  assert.ok(vp8 instanceof Uint8Array);
  assert.equal(ascii(vp8, 0, 4), "RIFF");
  assert.equal(ascii(vp8, 8, 12), "WEBP");
  assert.equal(ascii(vp8, 12, 16), "VP8 ");
  assert.deepEqual([...vp8.subarray(23, 26)], [0x9d, 0x01, 0x2a]);
  assert.equal(u16le(vp8, 26) & 0x3fff, 321);
  assert.equal(u16le(vp8, 28) & 0x3fff, 123);

  const vp8l = buildWebpVp8l({width: 400, height: 500});
  assert.equal(ascii(vp8l, 12, 16), "VP8L");
  assert.equal(vp8l[20], 0x2f);
  const bits = vp8l[21] | (vp8l[22] << 8) | (vp8l[23] << 16) | (vp8l[24] << 24);
  assert.equal((bits & 0x3fff) + 1, 400);
  assert.equal(((bits >>> 14) & 0x3fff) + 1, 500);

  const vp8x = buildWebpVp8x({width: 640, height: 480});
  assert.equal(ascii(vp8x, 12, 16), "VP8X");
  assert.equal(vp8x[20] & 0x02, 0, "static: no animation flag");
  assert.equal(u24le(vp8x, 24) + 1, 640);
  assert.equal(u24le(vp8x, 27) + 1, 480);
  assert.ok(!ascii(vp8x, 0, vp8x.length).includes("ANIM"));

  const animatedFlag = buildWebpVp8x({width: 8, height: 8, animated: true});
  assert.equal(animatedFlag[20] & 0x02, 0x02);

  const staticWithAnim = buildWebpVp8x({width: 8, height: 8, animChunk: true});
  assert.equal(staticWithAnim[20] & 0x02, 0);
  assert.ok(ascii(staticWithAnim, 0, staticWithAnim.length).includes("ANIM"));

  const staticWithAnmf = buildWebpVp8x({width: 8, height: 8, anmfChunk: true});
  assert.ok(ascii(staticWithAnmf, 0, staticWithAnmf.length).includes("ANMF"));
});

test("RIFF sizes are consistent for well-formed WebP builders", () => {
  for (const bytes of [
    buildWebpVp8({width: 3, height: 3}),
    buildWebpVp8l({width: 3, height: 3}),
    buildWebpVp8x({width: 3, height: 3}),
  ]) {
    assert.equal(
      bytes.length,
      u32le(bytes, 4) + 8,
    );
  }
});

test("non-supported signatures and crafted limit headers", () => {
  const gif = buildGifSignature();
  assert.equal(ascii(gif, 0, 6), "GIF89a");
  assert.ok(ascii(buildSvgBytes(), 0, 200).includes("<svg"));
  const avif = buildAvifSignature();
  assert.equal(ascii(avif, 4, 8), "ftyp");
  assert.equal(ascii(avif, 8, 12), "avif");
  assert.equal(ascii(buildBmpSignature(), 0, 2), "BM");

  const wide = buildPng({width: 8193, height: 16});
  assert.equal(u32be(wide, 16), 8193);
  const square = buildPng({width: 7072, height: 7072});
  assert.equal(u32be(square, 16) * u32be(square, 20), 50_013_184);
});

test("truncated and zero-dimension cases are non-empty Uint8Arrays", () => {
  const truncated = buildTruncatedCases();
  assert.ok(truncated.length >= 8);
  for (const {name, bytes} of truncated) {
    assert.ok(bytes instanceof Uint8Array, name);
    assert.ok(bytes.length > 0, name);
  }
  assert.equal(truncate(buildPng({width: 1, height: 1}), 10).length, 10);

  const zeros = buildZeroDimensionCases();
  assert.ok(zeros.length >= 4);
  for (const {name, bytes} of zeros) {
    assert.ok(bytes instanceof Uint8Array, name);
  }
});

test("pseudoRandomBytes is deterministic", () => {
  assert.deepEqual(pseudoRandomBytes(7, 32), pseudoRandomBytes(7, 32));
  assert.notDeepEqual(pseudoRandomBytes(7, 32), pseudoRandomBytes(8, 32));
  assert.equal(pseudoRandomBytes(1, 0).length, 0);
});
