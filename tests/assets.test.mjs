import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {describe, it} from "node:test";
import {inflateSync} from "node:zlib";
import {
  backgroundAssets,
  toraPoseAssets,
} from "../src/assets.ts";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const crcTable = Array.from({length: 256}, (_, value) => {
  let current = value;

  for (let bit = 0; bit < 8; bit += 1) {
    current =
      current & 1
        ? 0xedb88320 ^ (current >>> 1)
        : current >>> 1;
  }

  return current >>> 0;
});

const crc32 = (buffer) => {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
};

const validatePng = async (relativePath) => {
  const data = await readFile(resolve("public", relativePath));

  assert.deepEqual(
    data.subarray(0, PNG_SIGNATURE.length),
    PNG_SIGNATURE,
    `${relativePath}: invalid PNG signature`,
  );

  let offset = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawEnd = false;
  const compressedImageData = [];

  while (offset < data.length) {
    assert.ok(
      offset + 12 <= data.length,
      `${relativePath}: truncated PNG chunk`,
    );

    const length = data.readUInt32BE(offset);
    offset += 4;

    const type = data.subarray(offset, offset + 4);
    offset += 4;

    assert.ok(
      offset + length + 4 <= data.length,
      `${relativePath}: chunk exceeds file length`,
    );

    const payload = data.subarray(offset, offset + length);
    offset += length;

    const expectedCrc = data.readUInt32BE(offset);
    offset += 4;

    const chunkName = type.toString("ascii");
    const actualCrc = crc32(Buffer.concat([type, payload]));

    assert.equal(
      actualCrc,
      expectedCrc,
      `${relativePath}: invalid CRC for ${chunkName}`,
    );

    if (chunkName === "IHDR") {
      sawHeader = true;
    }

    if (chunkName === "IDAT") {
      compressedImageData.push(payload);
    }

    if (chunkName === "IEND") {
      sawEnd = true;
      break;
    }
  }

  assert.ok(sawHeader, `${relativePath}: missing IHDR`);
  assert.ok(
    compressedImageData.length > 0,
    `${relativePath}: missing IDAT`,
  );
  assert.ok(sawEnd, `${relativePath}: missing IEND`);
  assert.equal(
    offset,
    data.length,
    `${relativePath}: trailing bytes after IEND`,
  );

  assert.doesNotThrow(
    () => inflateSync(Buffer.concat(compressedImageData)),
    `${relativePath}: invalid compressed IDAT stream`,
  );
};

describe("PNG assets", () => {
  const assets = [
    ...Object.values(toraPoseAssets),
    ...Object.values(backgroundAssets),
  ];

  for (const asset of assets) {
    it(`validates ${asset}`, async () => {
      await validatePng(asset);
    });
  }
});
