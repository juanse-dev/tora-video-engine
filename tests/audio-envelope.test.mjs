import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, before, describe, it} from "node:test";
import {
  decodeMp4AudioMono,
  ENVELOPE_SAMPLE_RATE,
  goertzelWindows,
} from "./helpers/audioEnvelope.mjs";
import {runFfmpeg} from "./helpers/ffmpeg.mjs";

const tone = (hz, seconds, amplitude = 1, startSeconds = 0, totalSeconds = seconds + startSeconds) => {
  const samples = new Float32Array(Math.round(totalSeconds * ENVELOPE_SAMPLE_RATE));

  for (let index = 0; index < samples.length; index += 1) {
    const time = index / ENVELOPE_SAMPLE_RATE;

    if (time >= startSeconds && time < startSeconds + seconds) {
      samples[index] = amplitude * Math.sin(2 * Math.PI * hz * time);
    }
  }

  return samples;
};

const mix = (...signals) => {
  const out = new Float32Array(Math.max(...signals.map((signal) => signal.length)));

  for (const signal of signals) {
    for (let index = 0; index < signal.length; index += 1) {
      out[index] += signal[index];
    }
  }

  return out;
};

const near = (actual, expected, tolerance) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} is not within ${tolerance} of ${expected}`,
  );

describe("goertzelWindows on synthetic tones", () => {
  it("reads the amplitude of a tone per 100 ms window", () => {
    const windows = goertzelWindows(tone(440, 1, 0.5), 440, 100);

    assert.equal(windows.length, 10);

    for (const amplitude of windows) {
      near(amplitude, 0.5, 0.01);
    }
  });

  it("reads ~0 for other frequencies and for silence", () => {
    const samples = tone(440, 1, 1);

    for (const hz of [220, 880, 1000]) {
      for (const amplitude of goertzelWindows(samples, hz, 100)) {
        assert.ok(amplitude < 0.02, `${hz} Hz read ${amplitude}`);
      }
    }

    for (const amplitude of goertzelWindows(new Float32Array(48_000), 440, 100)) {
      assert.equal(amplitude, 0);
    }
  });

  it("follows a tone that starts and stops, window by window", () => {
    // 0.5 s of silence, 0.5 s of 440 Hz, 0.5 s of silence.
    const windows = goertzelWindows(tone(440, 0.5, 0.8, 0.5, 1.5), 440, 100);

    assert.equal(windows.length, 15);
    windows.slice(0, 5).forEach((amplitude) => assert.ok(amplitude < 0.01));
    windows.slice(5, 10).forEach((amplitude) => near(amplitude, 0.8, 0.01));
    windows.slice(10).forEach((amplitude) => assert.ok(amplitude < 0.01));
  });

  it("tells simultaneous tones apart (music 220 Hz under a voice 440 Hz)", () => {
    const samples = mix(tone(220, 1, 0.4), tone(440, 1, 0.2));

    near(goertzelWindows(samples, 220, 100)[5], 0.4, 0.01);
    near(goertzelWindows(samples, 440, 100)[5], 0.2, 0.01);
    assert.ok(goertzelWindows(samples, 880, 100)[5] < 0.02);
  });

  it("drops a trailing partial window and rejects unusable arguments", () => {
    assert.equal(goertzelWindows(tone(440, 0.25), 440, 100).length, 2);
    assert.throws(() => goertzelWindows(tone(440, 1), 0, 100), /hz must be in/u);
    assert.throws(() => goertzelWindows(tone(440, 1), 24_000, 100), /hz must be in/u);
    assert.throws(() => goertzelWindows(tone(440, 1), 440, 0), /windowMs is too small/u);
  });
});

describe("decodeMp4AudioMono on a real AAC track", () => {
  let directory;
  let tonePath;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "tora-envelope-test-"));
    tonePath = join(directory, "tone.mp4");

    // 1 s of a 440 Hz sine at amplitude 0.5, encoded as AAC in an MP4 (what the renders produce).
    await runFfmpeg([
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1:sample_rate=48000",
      "-af",
      "volume=4,pan=stereo|c0=c0|c1=c0",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-f",
      "mp4",
      "-y",
      tonePath,
    ]);
  });
  after(async () => {
    await rm(directory, {recursive: true, force: true});
  });

  it("decodes about one second of mono 48 kHz samples that Goertzel finds at 440 Hz", async () => {
    const samples = await decodeMp4AudioMono(tonePath);

    assert.ok(samples instanceof Float32Array);
    assert.ok(samples.length >= 48_000 && samples.length <= 49_500, `${samples.length}`);

    const windows = goertzelWindows(samples, 440, 100);
    const middle = windows.slice(2, 8);

    for (const amplitude of middle) {
      near(amplitude, 0.5, 0.05);
    }

    // The positive control above proves the decode is not silence; now a wrong frequency.
    for (const amplitude of goertzelWindows(samples, 880, 100).slice(2, 8)) {
      assert.ok(amplitude < 0.03, `880 Hz read ${amplitude}`);
    }
  });

  it("throws a clear error for a file that cannot be decoded", async () => {
    await assert.rejects(
      decodeMp4AudioMono(join(directory, "missing.mp4")),
      /decodeMp4AudioMono failed/u,
    );
  });
});
