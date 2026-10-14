import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  MAX_AUDIO_DURATION_SECONDS,
  MAX_LOCAL_ASSET_BYTES,
  MAX_LOCAL_AUDIO_BYTES,
} from "../src/localAssets/limits.ts";
import {payloadKindOf} from "../src/localAssets/readiness.ts";
import {buildLocalAssetRef} from "../src/localAssets/refs.ts";
import {MAX_WAVEFORM_PEAKS} from "../src/audio/constants.ts";
import {
  decodeAssetRow,
  decodePayloadMeta,
  decodeWaveform,
  payloadMatchesCategory,
} from "../src/web/assetLibrary/records.ts";

const digestOf = (n) => n.toString(16).padStart(64, "0");
const DIGEST = digestOf(1);
const audioRef = (n) => buildLocalAssetRef("audio", digestOf(n));
const poseRef = (n) => buildLocalAssetRef("pose", digestOf(n));
const CREATED_AT = "2026-01-02T03:04:05.000Z";
const validRow = {label: "Voice", originalFilename: "voice.mp3", createdAt: CREATED_AT};
const imageMeta = {mimeType: "image/png", byteSize: 100, width: 10, height: 20};
const audioMeta = {
  kind: "audio",
  mimeType: "audio/mpeg",
  byteSize: 36_381,
  container: "mp3",
  codec: "mp3",
  durationSeconds: 2.2465,
  sampleRate: 44_100,
  channels: 2,
};
const MIB = 1024 * 1024;

describe("decodePayloadMeta: image records are unchanged", () => {
  it("returns the v0.3 shape without a kind field", () => {
    assert.deepEqual(decodePayloadMeta(DIGEST, imageMeta), {status: "present", value: imageMeta});
    assert.equal("kind" in decodePayloadMeta(DIGEST, imageMeta).value, false);
    assert.equal(payloadKindOf(decodePayloadMeta(DIGEST, imageMeta).value), "image");
  });

  it("tolerates a stored kind: image and drops it", () => {
    assert.deepEqual(decodePayloadMeta(DIGEST, {...imageMeta, kind: "image"}), {status: "present", value: imageMeta});
  });

  it("rejects an unknown kind", () => {
    for (const kind of ["Audio", "video", "", 3, null]) {
      assert.equal(decodePayloadMeta(DIGEST, {...imageMeta, kind}).status, "corrupt", String(kind));
    }
  });

  it("keeps the 25 MiB image ceiling: a 30 MiB image record is corrupt", () => {
    assert.equal(decodePayloadMeta(DIGEST, {...imageMeta, byteSize: MAX_LOCAL_ASSET_BYTES}).status, "present");
    assert.equal(decodePayloadMeta(DIGEST, {...imageMeta, byteSize: 30 * MIB}).status, "corrupt");
  });
});

describe("decodePayloadMeta: audio records", () => {
  it("decodes a valid record exactly", () => {
    assert.deepEqual(decodePayloadMeta(DIGEST, audioMeta), {status: "present", value: audioMeta});
    assert.equal(payloadKindOf(audioMeta), "audio");
  });

  it("accepts every accepted (container, codec, mime) triple", () => {
    for (const [container, codec, mimeType] of [
      ["mp3", "mp3", "audio/mpeg"], ["wave", "pcm", "audio/wav"], ["mp4", "aac", "audio/mp4"], ["ogg", "opus", "audio/ogg"],
    ]) {
      assert.equal(decodePayloadMeta(DIGEST, {...audioMeta, container, codec, mimeType}).status, "present", container);
    }
  });

  it("accepts a 30 MiB audio record and rejects 50 MiB + 1", () => {
    assert.equal(decodePayloadMeta(DIGEST, {...audioMeta, byteSize: 30 * MIB}).status, "present");
    assert.equal(decodePayloadMeta(DIGEST, {...audioMeta, byteSize: MAX_LOCAL_AUDIO_BYTES}).status, "present");
    assert.equal(decodePayloadMeta(DIGEST, {...audioMeta, byteSize: MAX_LOCAL_AUDIO_BYTES + 1}).status, "corrupt");
  });

  it("rejects out-of-range or mistyped fields", () => {
    const bad = [
      {mimeType: "audio/ogg"}, // not the container's MIME type
      {mimeType: "image/png"},
      {container: "flac"}, {container: 7},
      {codec: "vorbis"}, {codec: "aac"}, // not an accepted pair for mp3
      {byteSize: 0}, {byteSize: -1}, {byteSize: 1.5}, {byteSize: Number.NaN}, {byteSize: "36381"},
      {durationSeconds: 0}, {durationSeconds: -1}, {durationSeconds: Number.NaN}, {durationSeconds: Number.POSITIVE_INFINITY},
      {durationSeconds: MAX_AUDIO_DURATION_SECONDS + 0.001}, {durationSeconds: "2.2"},
      {sampleRate: 7_999}, {sampleRate: 96_001}, {sampleRate: 44_100.5}, {sampleRate: Number.NaN},
      {channels: 0}, {channels: 3}, {channels: 1.5}, {channels: -1}, {channels: Number.NaN},
    ];

    for (const patch of bad) {
      assert.equal(decodePayloadMeta(DIGEST, {...audioMeta, ...patch}).status, "corrupt", JSON.stringify(patch));
    }
  });

  it("is strict: any extra key, including identity fields, is corrupt", () => {
    for (const extra of [{width: 10}, {thumbnail: 1}, {digest: DIGEST}, {digest: digestOf(2)}, {ref: audioRef(1)}, {ref: audioRef(2)}, {category: "audio"}]) {
      assert.equal(decodePayloadMeta(DIGEST, {...audioMeta, ...extra}).status, "corrupt", JSON.stringify(extra));
    }

    const missing = {...audioMeta};

    delete missing.channels;
    assert.equal(decodePayloadMeta(DIGEST, missing).status, "corrupt");
  });

  it("maps undefined to absent and a bad key to corrupt", () => {
    assert.deepEqual(decodePayloadMeta(DIGEST, undefined), {status: "absent"});
    assert.equal(decodePayloadMeta("not-a-digest", audioMeta).status, "corrupt");
  });
});

describe("payloadMatchesCategory: an audio row must point at audio metadata and an image row at image metadata", () => {
  it("matches by kind", () => {
    assert.equal(payloadMatchesCategory(audioMeta, "audio"), true);
    assert.equal(payloadMatchesCategory(audioMeta, "pose"), false);
    assert.equal(payloadMatchesCategory(audioMeta, "background"), false);
    assert.equal(payloadMatchesCategory(imageMeta, "pose"), true);
    assert.equal(payloadMatchesCategory(imageMeta, "background"), true);
    assert.equal(payloadMatchesCategory(imageMeta, "audio"), false);
  });
});

describe("decodeWaveform", () => {
  const peaks = Uint8Array.from([0, 10, 255]);

  it("decodes exactly {peaksPerSecond, peaks}", () => {
    assert.deepEqual(decodeWaveform(DIGEST, {peaksPerSecond: 50, peaks}), {status: "present", value: {peaksPerSecond: 50, peaks}});
    assert.deepEqual(decodeWaveform(DIGEST, undefined), {status: "absent"});
  });

  it("rejects any extra key, including a digest of the right or the wrong value (the key is the only identity)", () => {
    for (const extra of [{digest: DIGEST}, {digest: digestOf(2)}, {ref: audioRef(1)}, {category: "audio"}, {other: 1}]) {
      assert.equal(decodeWaveform(DIGEST, {peaksPerSecond: 50, peaks, ...extra}).status, "corrupt", JSON.stringify(extra));
    }
  });

  it("rejects bad peaksPerSecond and bad peaks", () => {
    for (const peaksPerSecond of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "50", undefined]) {
      assert.equal(decodeWaveform(DIGEST, {peaksPerSecond, peaks}).status, "corrupt", String(peaksPerSecond));
    }

    for (const bad of [[], [1, 2, 3], new Uint8Array(0), new Uint16Array(3), new Float32Array(3), "abc", null, new Uint8Array(MAX_WAVEFORM_PEAKS + 1)]) {
      assert.equal(decodeWaveform(DIGEST, {peaksPerSecond: 50, peaks: bad}).status, "corrupt");
    }

    assert.equal(decodeWaveform(DIGEST, {peaksPerSecond: 50, peaks: new Uint8Array(MAX_WAVEFORM_PEAKS)}).status, "present");
    assert.equal(decodeWaveform(DIGEST, {peaks}).status, "corrupt");
    assert.equal(decodeWaveform(DIGEST, {peaksPerSecond: 50}).status, "corrupt");
    assert.equal(decodeWaveform(DIGEST, null).status, "corrupt");
    assert.equal(decodeWaveform("nope", {peaksPerSecond: 50, peaks}).status, "corrupt");
  });
});

describe("decodeAssetRow for audio keys (category-correct)", () => {
  it("decodes a canonical audio row and tolerates only identity fields equal to what the key implies", () => {
    assert.deepEqual(decodeAssetRow(audioRef(1), validRow), {status: "present", value: validRow});
    assert.deepEqual(decodeAssetRow(audioRef(1), {...validRow, ref: audioRef(1), category: "audio", digest: DIGEST}), {status: "present", value: validRow});

    for (const extra of [{category: "pose"}, {category: "background"}, {ref: poseRef(1)}, {ref: audioRef(2)}, {digest: digestOf(2)}]) {
      assert.equal(decodeAssetRow(audioRef(1), {...validRow, ...extra}).status, "corrupt", JSON.stringify(extra));
    }
  });
});
