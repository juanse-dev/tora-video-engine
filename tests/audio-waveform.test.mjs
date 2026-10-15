import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {drawWaveformBars} from "../src/web/audio/drawWaveform.ts";
import {waveformColumns} from "../src/web/audio/waveformColumns.ts";
import {createLocalAssetPageController} from "../src/web/localAssetPageController.ts";

const peaksOf = (values) => ({peaksPerSecond: 50, peaks: Uint8Array.from(values)});

describe("waveformColumns", () => {
  it("takes the largest stored peak under each column", () => {
    // 4 peaks at 50 per second cover 0.08 s; two columns split them in pairs.
    const columns = waveformColumns(peaksOf([0, 255, 51, 102]), 0.08, 2);

    assert.deepEqual([...columns], [1, Math.fround(102 / 255)]);
  });

  it("gives one column per peak when they match, and repeats a peak when columns outnumber peaks", () => {
    assert.deepEqual([...waveformColumns(peaksOf([255, 0, 51]), 0.06, 3)], [1, 0, Math.fround(51 / 255)]);
    assert.deepEqual([...waveformColumns(peaksOf([255, 51]), 0.04, 4)], [1, 1, Math.fround(51 / 255), Math.fround(51 / 255)]);
  });

  it("shows only the first seconds asked for, and leaves columns past the stored peaks at zero", () => {
    const peaks = peaksOf([255, 255, 255, 255]);

    assert.deepEqual([...waveformColumns(peaks, 0.04, 2)], [1, 1]);
    // The four stored peaks cover 0.08 s: the last two of four columns are past them.
    assert.deepEqual([...waveformColumns(peaks, 0.16, 4)], [1, 1, 0, 0]);
  });

  it("returns zeros, never NaN, for unusable input", () => {
    const peaks = peaksOf([255]);

    assert.deepEqual([...waveformColumns(peaks, 0, 3)], [0, 0, 0]);
    assert.deepEqual([...waveformColumns(peaks, Number.NaN, 3)], [0, 0, 0]);
    assert.deepEqual([...waveformColumns({peaksPerSecond: 0, peaks: peaks.peaks}, 1, 2)], [0, 0]);
    assert.deepEqual([...waveformColumns(peaksOf([]), 1, 2)], [0, 0]);
    assert.equal(waveformColumns(peaks, 1, 0).length, 0);
    assert.equal(waveformColumns(peaks, 1, -4).length, 0);
    assert.equal(waveformColumns(peaks, 1, Number.NaN).length, 0);
  });
});

describe("drawWaveformBars", () => {
  const recorder = () => {
    const calls = [];

    return {
      calls,
      context: {
        fillStyle: "",
        clearRect: () => calls.push(["clear"]),
        fillRect: (...args) => calls.push(["fill", ...args]),
      },
    };
  };

  it("draws a mirrored bar for every sounding column and nothing for silence", () => {
    const {calls, context} = recorder();

    drawWaveformBars(context, Float32Array.from([1, 0, 0.5]), {width: 30, height: 20}, "#fff");

    assert.equal(context.fillStyle, "#fff");
    assert.deepEqual(calls, [
      ["fill", 0, 0, 9.5, 20],
      ["fill", 20, 5, 9.5, 10],
    ]);
  });

  it("keeps a very quiet column at least one pixel tall and clamps loud values", () => {
    const {calls, context} = recorder();

    drawWaveformBars(context, Float32Array.from([0.001, 7]), {width: 4, height: 10}, "red");

    assert.deepEqual(calls, [
      ["fill", 0, 4.5, 1.5, 1],
      ["fill", 2, 0, 1.5, 10],
    ]);
  });

  it("draws nothing for an empty or zero-sized area", () => {
    const {calls, context} = recorder();

    drawWaveformBars(context, new Float32Array(0), {width: 10, height: 10}, "red");
    drawWaveformBars(context, Float32Array.from([1]), {width: 0, height: 10}, "red");
    drawWaveformBars(context, Float32Array.from([1]), {width: 10, height: 0}, "red");
    assert.deepEqual(calls, []);
  });
});

describe("the My audio page carries stored waveforms", () => {
  const digestOf = (n) => n.toString(16).padStart(64, "0");
  const refOf = (n) => `local:audio:sha256:${digestOf(n)}`;
  const row = (n) => ({
    status: "present",
    value: {label: `Sound ${n}`, originalFilename: `s${n}.wav`, createdAt: "2026-01-01T00:00:00.000Z"},
  });
  const audioMeta = {
    kind: "audio", mimeType: "audio/wav", byteSize: 10, container: "wave", codec: "pcm",
    durationSeconds: 2, sampleRate: 48_000, channels: 2,
  };
  const makeStore = (getWaveform) => {
    const refs = [1, 2, 3].map(refOf);

    return {
      async listAssets() {
        return refs.map((ref, index) => ({ref, row: row(index + 1)}));
      },
      async countAssets() {
        return refs.length;
      },
      async getAssetRow(ref) {
        return refs.includes(ref) ? row(refs.indexOf(ref) + 1) : {status: "absent"};
      },
      async getPayloadMeta() {
        return {status: "present", value: audioMeta};
      },
      getWaveform,
    };
  };

  it("adds the stored peaks to an entry, and leaves the key out when they are absent, corrupt or unreadable", async () => {
    const peaks = {peaksPerSecond: 50, peaks: Uint8Array.from([1, 2, 3])};
    const controller = createLocalAssetPageController({
      store: makeStore(async (digest) => {
        if (digest === digestOf(1)) return {status: "present", value: peaks};
        if (digest === digestOf(2)) return {status: "corrupt", reason: "bad"};

        throw new Error("read failed");
      }),
      category: "audio",
      createUrl: () => "blob:test",
      revokeUrl: () => {},
    });

    await controller.sync(null);

    const {entries} = controller.getSnapshot();

    assert.equal(entries[0].waveform, peaks);
    assert.equal("waveform" in entries[1], false);
    assert.equal("waveform" in entries[2], false);
    assert.equal(entries.every((entry) => entry.audio.durationSeconds === 2), true);
    controller.dispose();
  });
});
