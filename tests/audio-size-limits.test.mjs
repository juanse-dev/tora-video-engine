import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {checkLocalAssetByteSize} from "../src/localAssets/imageInspection.ts";
import {
  MAX_LOCAL_ASSET_BYTES,
  MAX_LOCAL_AUDIO_BYTES,
  maxLocalAssetBytes,
} from "../src/localAssets/limits.ts";
import {buildWav} from "./helpers/audioBytes.mjs";
import {inspectAudio} from "../src/localAssets/audioInspection.ts";

const MIB = 1024 * 1024;

describe("per-category byte limits", () => {
  it("maps each category to its own ceiling", () => {
    assert.equal(maxLocalAssetBytes("pose"), 25 * MIB);
    assert.equal(maxLocalAssetBytes("background"), 25 * MIB);
    assert.equal(maxLocalAssetBytes("audio"), 50 * MIB);
    assert.equal(MAX_LOCAL_ASSET_BYTES, 25 * MIB);
    assert.equal(MAX_LOCAL_AUDIO_BYTES, 50 * MIB);
  });

  it("accepts 30 MiB of audio and rejects a 26 MiB image (image limit unchanged)", () => {
    assert.deepEqual(checkLocalAssetByteSize(30 * MIB, "audio"), {ok: true});
    assert.deepEqual(checkLocalAssetByteSize(26 * MIB, "pose"), {ok: false, reason: "too-large"});
    assert.deepEqual(checkLocalAssetByteSize(26 * MIB, "background"), {ok: false, reason: "too-large"});
    assert.deepEqual(checkLocalAssetByteSize(25 * MIB, "pose"), {ok: true});
  });

  it("bounds audio at exactly 50 MiB and treats zero as empty", () => {
    assert.deepEqual(checkLocalAssetByteSize(50 * MIB, "audio"), {ok: true});
    assert.deepEqual(checkLocalAssetByteSize(50 * MIB + 1, "audio"), {ok: false, reason: "too-large"});
    assert.deepEqual(checkLocalAssetByteSize(0, "audio"), {ok: false, reason: "empty"});
    assert.deepEqual(checkLocalAssetByteSize(Number.NaN, "audio"), {ok: false, reason: "empty"});
  });
});

describe("generated large WAVs (built at test time, never committed)", () => {
  it("a 30 MiB 48 kHz stereo WAV is about 164 s and inspects as valid audio", async () => {
    const wav = buildWav({dataBytes: 30 * MIB - 44});

    assert.equal(wav.length, 30 * MIB);

    const result = await inspectAudio(wav);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(Math.abs(result.metadata.durationSeconds - 163.84) < 0.01, `${result.metadata.durationSeconds}`);
  });

  it("a 51 MiB file with a valid WAV header is rejected by size before the reader runs", async () => {
    const wav = buildWav({dataBytes: 51 * MIB - 44});
    let reads = 0;
    const result = await inspectAudio(wav, {readInfo: async () => { reads += 1; throw new Error("must not read"); }});

    assert.equal(result.ok, false);
    assert.match(result.message, /larger than 50 MiB/u);
    assert.equal(reads, 0);
  });
});
