import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

/** Reads a committed fixture from tests/fixtures/local-audio as a Uint8Array. */
export const fixtureBytes = (name) =>
  new Uint8Array(
    readFileSync(new URL(`../fixtures/local-audio/${name}`, import.meta.url)),
  );

/** Walks the RIFF chunks of a WAV and returns its format fields and data size. */
export const readWavHeader = (bytes) => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");

  let offset = 12;
  let format = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);

    if (id === "fmt ") {
      format = {
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bitsPerSample: buffer.readUInt16LE(offset + 22),
      };
    } else if (id === "data") {
      assert.notEqual(format, null, "fmt chunk must precede data");

      const blockAlign = (format.channels * format.bitsPerSample) / 8;

      return {
        ...format,
        dataBytes: size,
        frames: blockAlign === 0 ? 0 : size / blockAlign,
      };
    }

    offset += 8 + size + (size % 2);
  }

  throw new Error("No data chunk");
};

/**
 * A silent 16-bit PCM WAV with a valid 44-byte header. `dataBytes` (a multiple
 * of the block size) overrides `seconds`; it lets a test build a 30 MiB or a
 * 51 MiB file without any encoder.
 */
export const buildWav = ({
  sampleRate = 48_000,
  channels = 2,
  seconds = 1,
  dataBytes,
} = {}) => {
  const blockAlign = channels * 2;
  const data = dataBytes ?? Math.round(seconds * sampleRate) * blockAlign;
  const buffer = Buffer.alloc(44 + data);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + data, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(data, 40);

  return buffer;
};
