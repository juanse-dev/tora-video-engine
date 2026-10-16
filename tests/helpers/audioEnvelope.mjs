// Measuring the sound of a rendered MP4 (AUDIO-005 integration tests; AUDIO-006
// builds its parity and golden measurements on these two functions).
//
// The audio of the MP4 is decoded to mono PCM with the ffmpeg that ships with
// Remotion, then a Goertzel filter reads the amplitude of one frequency in
// consecutive windows. The fixtures are pure tones (music 220 Hz, voice 440 Hz,
// sfx 880 Hz), so the amplitude per window tells which track sounds and how loud.
// Always include a positive control: a broken decode returns silence that looks
// like legitimate silence.

import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runFfmpeg} from "./ffmpeg.mjs";

export const ENVELOPE_SAMPLE_RATE = 48_000;

/** The `data` chunk of a 16-bit PCM WAV as floats in [-1, 1). */
const readPcm16Wav = (bytes) => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);

    if (id === "data") {
      const start = offset + 8;
      const end = Math.min(buffer.length, start + size);
      const samples = new Float32Array(Math.floor((end - start) / 2));

      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = buffer.readInt16LE(start + index * 2) / 32768;
      }

      return samples;
    }

    offset += 8 + size + (size % 2);
  }

  throw new Error("The decoded WAV has no data chunk");
};

/**
 * The first audio stream of an MP4 (or any media file) decoded to mono floats at
 * 48 kHz with the repository ffmpeg. Throws when the file has no audio stream.
 */
export const decodeMp4AudioMono = async (path) => {
  const directory = await mkdtemp(join(tmpdir(), "tora-envelope-"));
  const output = join(directory, "audio.wav");

  try {
    try {
      await runFfmpeg([
        "-v",
        "error",
        "-i",
        path,
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        String(ENVELOPE_SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        "-y",
        output,
      ]);
    } catch (error) {
      throw new Error(
        `decodeMp4AudioMono failed on ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return readPcm16Wav(new Uint8Array(await readFile(output)));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
};

/**
 * The amplitude of `hz` in consecutive, non-overlapping windows of `windowMs`
 * (a trailing partial window is dropped). A full-scale sine at `hz` reads ~1
 * and a sine of amplitude 0.25 reads ~0.25; silence and other frequencies read
 * ~0 (a window holds a whole number of cycles of the fixture tones at 100 ms).
 */
export const goertzelWindows = (
  samples,
  hz,
  windowMs,
  sampleRate = ENVELOPE_SAMPLE_RATE,
) => {
  const windowSize = Math.round((windowMs * sampleRate) / 1000);

  if (!Number.isFinite(hz) || hz <= 0 || hz >= sampleRate / 2) {
    throw new Error(`goertzelWindows: hz must be in (0, ${sampleRate / 2})`);
  }

  if (!Number.isInteger(windowSize) || windowSize < 1) {
    throw new Error("goertzelWindows: windowMs is too small");
  }

  const coefficient = 2 * Math.cos((2 * Math.PI * hz) / sampleRate);
  const amplitudes = [];

  for (
    let start = 0;
    start + windowSize <= samples.length;
    start += windowSize
  ) {
    let previous = 0;
    let beforePrevious = 0;

    for (let index = start; index < start + windowSize; index += 1) {
      const current = samples[index] + coefficient * previous - beforePrevious;

      beforePrevious = previous;
      previous = current;
    }

    const power =
      previous * previous +
      beforePrevious * beforePrevious -
      coefficient * previous * beforePrevious;

    amplitudes.push((2 * Math.sqrt(Math.max(0, power))) / windowSize);
  }

  return amplitudes;
};
