import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {isDecodeComplete} from "../src/audio/decodeCheck.ts";
import {inspectAudio} from "../src/localAssets/audioInspection.ts";
import {
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

  it("clamps values above full scale, ignores NaN, and clamps out-of-range frames to the ends", () => {
    const accumulator = createPeakAccumulator(1);

    accumulator.push(0, 100, [plane([1.5, Number.NaN])]);
    accumulator.push(1.5, 100, [plane([0.5])]);
    accumulator.push(-0.5, 100, [plane([1])]);

    const {peaks} = accumulator.finish();

    assert.equal(peaks[0], 255);
    assert.equal(peaks[49], 128);
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

  it("rejects with the abort reason when the signal is already aborted", async () => {
    const controller = new AbortController();

    controller.abort();
    await assert.rejects(decode("tone-220-10s.wav", {signal: controller.signal}), (error) => error.name === "AbortError");
  });

  it("an MP3 cannot be decoded in Node (no WebCodecs): AudioDecodeError, not a crash", {skip: typeof AudioDecoder !== "undefined"}, async () => {
    await assert.rejects(decode("tone-220-10s.mp3"), (error) => error instanceof AudioDecodeError && error.name === "AudioDecodeError");
  });
});
