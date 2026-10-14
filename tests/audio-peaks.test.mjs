import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {isDecodeComplete} from "../src/audio/decodeCheck.ts";
import {inspectAudio} from "../src/localAssets/audioInspection.ts";
import {
  AUDIO_DECODE_FAILED_MESSAGE,
  AudioDecodeError,
  createPeakAccumulator,
  decodeAudioPeaks,
  peakBucketCount,
} from "../src/web/assetLibrary/audioPeaks.ts";
import {fixtureBytes} from "./helpers/audioBytes.mjs";

const plane = (values) => Float32Array.from(values);

describe("peakBucketCount", () => {
  it("is ceil(duration x 50) capped at 15000, and at least 1", () => {
    assert.equal(peakBucketCount(10), 500);
    assert.equal(peakBucketCount(2.2), 111);
    assert.equal(peakBucketCount(0.12), 6);
    assert.equal(peakBucketCount(0.005), 1);
    assert.equal(peakBucketCount(300), 15_000);
    assert.equal(peakBucketCount(400), 15_000);
  });
});

describe("peak accumulator", () => {
  it("keeps the max |sample| over all channels per bucket, quantized to 0..255", () => {
    // 1 s at 100 Hz: 50 buckets of 2 frames.
    const accumulator = createPeakAccumulator(1);
    const left = new Array(100).fill(0);
    const right = new Array(100).fill(0);

    left[0] = 0.4;
    right[3] = -1;
    accumulator.push(0, 100, [plane(left), plane(right)]);

    const summary = accumulator.finish();

    assert.equal(summary.peaks.length, 50);
    assert.equal(summary.peaks[0], 102);
    assert.equal(summary.peaks[1], 255);
    assert.equal(summary.peaks.slice(2).every((value) => value === 0), true);
    assert.equal(summary.peaksPerSecond, 50);
    assert.equal(summary.decodedSeconds, 1);
  });

  it("clamps values above full scale, ignores NaN, and clamps out-of-range frames to the ends (one bucket per case)", () => {
    // 1 s at 100 Hz: 50 buckets of 2 frames.
    const accumulator = createPeakAccumulator(1);

    accumulator.push(0.1, 100, [plane([1.5])]); // above full scale -> bucket 5
    accumulator.push(0.5, 100, [plane([Number.NaN])]); // NaN alone -> bucket 25
    accumulator.push(1.5, 100, [plane([0.5])]); // after the end -> last bucket
    accumulator.push(-0.5, 100, [plane([0.3])]); // before the start -> bucket 0

    const {peaks} = accumulator.finish();

    assert.equal(peaks[5], 255);
    assert.equal(peaks[25], 0);
    assert.equal(peaks[49], 128);
    assert.equal(peaks[0], 77);
    assert.equal(peaks.filter((value) => value !== 0).length, 3);
  });

  it("gives the same peaks for one big chunk and for several chunks with their own start times", () => {
    const values = Array.from({length: 100}, (_, index) => Math.sin(index) * 0.9);
    const whole = createPeakAccumulator(1);
    const chunks = createPeakAccumulator(1);

    whole.push(0, 100, [plane(values)]);

    for (let start = 0; start < 100; start += 25) {
      chunks.push(start / 100, 100, [plane(values.slice(start, start + 25))]);
    }

    assert.deepEqual(chunks.finish().peaks, whole.finish().peaks);
  });

  it("derives peaksPerSecond from the bucket count and the duration, and reports 0 decoded seconds when nothing was pushed", () => {
    const accumulator = createPeakAccumulator(2.2);
    const summary = accumulator.finish();

    assert.equal(summary.peaks.length, 111);
    assert.equal(summary.peaksPerSecond, 111 / 2.2);
    assert.equal(summary.decodedSeconds, 0);
    assert.equal(isDecodeComplete(summary.decodedSeconds, 2.2), false);
  });
});

describe("decodeAudioPeaks on PCM fixtures (mediabunny decodes PCM without WebCodecs)", () => {
  const decode = async (name, deps) => {
    const bytes = fixtureBytes(name);
    const inspected = await inspectAudio(bytes);

    assert.equal(inspected.ok, true);

    return {
      metadata: inspected.metadata,
      summary: await decodeAudioPeaks(new Blob([bytes]), inspected.metadata, deps),
    };
  };

  it("a full-scale 220 Hz tone gives 500 peaks near 255 and a complete 10 s decode", async () => {
    const {metadata, summary} = await decode("tone-220-10s.wav");

    assert.equal(summary.peaks.length, 500);
    assert.equal(summary.peaksPerSecond, 50);
    assert.equal(summary.decodedSeconds, 10);
    assert.equal(Math.min(...summary.peaks) >= 250, true);
    assert.equal(isDecodeComplete(summary.decodedSeconds, metadata.durationSeconds), true);
  });

  it("decodes mono and short files with the right bucket count", async () => {
    assert.equal((await decode("mono-440.wav")).summary.peaks.length, 111);
    assert.equal((await decode("tone-880-0.4s.wav")).summary.peaks.length, 20);
  });

  it("stops consuming samples past the container duration plus the tolerance: they neither pile into the last bucket nor count as decoded", async () => {
    // 4 s of 48 kHz mono 16-bit PCM: 3 s of silence, then 1 s of full scale.
    const sampleRate = 48_000;
    const frames = 4 * sampleRate;
    const bytes = new Uint8Array(44 + frames * 2);
    const view = new DataView(bytes.buffer);
    const ascii = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));

    ascii(0, "RIFF");
    view.setUint32(4, bytes.byteLength - 8, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, frames * 2, true);

    for (let frame = 3 * sampleRate; frame < frames; frame += 1) {
      view.setInt16(44 + frame * 2, 32_767, true);
    }

    // The container says 2 s: everything from 2.25 s on must be ignored.
    const summary = await decodeAudioPeaks(new Blob([bytes]), {durationSeconds: 2});

    assert.equal(summary.peaks.length, 100);
    assert.equal(summary.peaks[99], 0);
    assert.equal(Math.max(...summary.peaks), 0);
    assert.ok(summary.decodedSeconds >= 2 && summary.decodedSeconds < 2.5, `${summary.decodedSeconds}`);
  });

  it("rejects with the abort reason when the signal is already aborted", async () => {
    const controller = new AbortController();

    controller.abort();
    await assert.rejects(decode("tone-220-10s.wav", {signal: controller.signal}), (error) => error.name === "AbortError");
  });

  it("a signal aborted before the call rejects with the abort reason without opening the file (an undecodable blob would otherwise give AudioDecodeError)", async () => {
    const controller = new AbortController();
    const metadata = {durationSeconds: 1};

    controller.abort();
    await assert.rejects(
      decodeAudioPeaks(new Blob(["not audio"]), metadata, {signal: controller.signal}),
      (error) => error.name === "AbortError",
    );
  });

  it("an undecodable file rejects with AudioDecodeError carrying exactly the user-facing text", async () => {
    await assert.rejects(
      decodeAudioPeaks(new Blob(["not audio"]), {durationSeconds: 1}),
      (error) =>
        error instanceof AudioDecodeError &&
        error.message === "This audio file could not be decoded." &&
        error.message === AUDIO_DECODE_FAILED_MESSAGE,
    );
  });

  it("a non-positive or non-finite container duration is refused up front with the same text", async () => {
    for (const durationSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        decodeAudioPeaks(new Blob(["x"]), {durationSeconds}),
        (error) => error instanceof AudioDecodeError && error.message === "This audio file could not be decoded.",
      );
    }
  });

  it("an MP3 cannot be decoded in Node (no WebCodecs): AudioDecodeError, not a crash", {skip: typeof AudioDecoder !== "undefined"}, async () => {
    await assert.rejects(decode("tone-220-10s.mp3"), (error) => error instanceof AudioDecodeError && error.name === "AudioDecodeError" && error.message === "This audio file could not be decoded.");
  });
});
