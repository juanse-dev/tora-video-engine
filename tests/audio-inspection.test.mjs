import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  AUDIO_CHANNELS_MESSAGE,
  AUDIO_CODEC_MESSAGE,
  AUDIO_DURATION_UNKNOWN_MESSAGE,
  AUDIO_EMPTY_MESSAGE,
  AUDIO_SAMPLE_RATE_MESSAGE,
  AUDIO_TOO_LARGE_MESSAGE,
  AUDIO_TOO_LONG_MESSAGE,
  AUDIO_TRACKS_MESSAGE,
  AUDIO_UNSUPPORTED_MESSAGE,
  AUDIO_VIDEO_MESSAGE,
  AUDIO_VORBIS_MESSAGE,
  audioFileExtensionFor,
  audioMimeTypeFor,
  evaluateRawAudioInfo,
  inspectAudio,
  isAcceptedAudioCombination,
} from "../src/localAssets/audioInspection.ts";
import {MAX_LOCAL_AUDIO_BYTES} from "../src/localAssets/limits.ts";
import {fixtureBytes} from "./helpers/audioBytes.mjs";

const accepted = [
  ["tone-220-10s.mp3", "mp3", "mp3", 10.031, 44_100, 2],
  ["tone-220-10s.wav", "wave", "pcm", 10, 48_000, 2],
  ["tone-220-10s.m4a", "mp4", "aac", 10, 44_100, 2],
  ["tone-220-10s.opus.ogg", "ogg", "opus", 10.0135, 48_000, 2],
  ["tone-440-2.2s.wav", "wave", "pcm", 2.2, 48_000, 2],
  ["tone-440-2.2s.m4a", "mp4", "aac", 2.2, 44_100, 2],
  ["tone-880-0.4s.wav", "wave", "pcm", 0.4, 48_000, 2],
  ["tone-880-0.4s.opus.ogg", "ogg", "opus", 0.4135, 48_000, 2],
  ["tone-220-12s.wav", "wave", "pcm", 12, 48_000, 2],
  ["mono-440.wav", "wave", "pcm", 2.2, 48_000, 1],
  ["noise-2s.mp3", "mp3", "mp3", 2.0376, 44_100, 2],
];

describe("inspectAudio on the fixtures", () => {
  for (const [name, container, codec, seconds, sampleRate, channels] of accepted) {
    it(`accepts ${name}`, async () => {
      const result = await inspectAudio(fixtureBytes(name));

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(Object.keys(result.metadata).sort(), ["channels", "codec", "container", "durationSeconds", "sampleRate"]);
      assert.equal(result.metadata.container, container);
      assert.equal(result.metadata.codec, codec);
      assert.equal(result.metadata.sampleRate, sampleRate);
      assert.equal(result.metadata.channels, channels);
      assert.ok(Math.abs(result.metadata.durationSeconds - seconds) < 0.0005, `${name}: ${result.metadata.durationSeconds}`);
    });
  }

  it("reports the declared (metadata) duration of the truncated MP3, not the shorter scanned one", async () => {
    const result = await inspectAudio(fixtureBytes("truncated.mp3"));

    assert.equal(result.ok, true);
    assert.ok(Math.abs(result.metadata.durationSeconds - 10.031) < 0.0005, `${result.metadata.durationSeconds}`);
  });

  it("reports the real length of an MP3 whose Xing/Info header declares less than the file holds (three joined copies)", async () => {
    const one = fixtureBytes("tone-220-10s.mp3");
    const joined = new Uint8Array(one.byteLength * 3);

    for (let copy = 0; copy < 3; copy += 1) {
      joined.set(one, copy * one.byteLength);
    }

    const result = await inspectAudio(joined);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(Math.abs(result.metadata.durationSeconds - 30.093) < 0.1, `${result.metadata.durationSeconds}`);
  });

  it("rejects an MP3 whose stale header hides a length over the limit (31 joined copies, ~311 s)", async () => {
    const one = fixtureBytes("tone-220-10s.mp3");
    const joined = new Uint8Array(one.byteLength * 31);

    for (let copy = 0; copy < 31; copy += 1) {
      joined.set(one, copy * one.byteLength);
    }

    const result = await inspectAudio(joined);

    assert.deepEqual(result, {ok: false, message: AUDIO_TOO_LONG_MESSAGE});
  });

  it("gives the same result for a Blob and a Uint8Array", async () => {
    for (const [name] of accepted) {
      const bytes = fixtureBytes(name);

      assert.deepEqual(await inspectAudio(new Blob([bytes])), await inspectAudio(bytes), name);
    }
  });

  const rejected = [
    ["a text file", "not-audio.txt", AUDIO_UNSUPPORTED_MESSAGE],
    ["an MP4 with a video track", "with-video.mp4", AUDIO_VIDEO_MESSAGE],
    ["a 301 s MP3", "long-301s.mp3", AUDIO_TOO_LONG_MESSAGE],
    ["a 3-channel WAV", "three-channel.wav", "Audio must be mono or stereo."],
    ["a 0-channel WAV", "zero-channel.wav", "Audio must be mono or stereo."],
  ];

  for (const [title, name, message] of rejected) {
    it(`rejects ${title} with its exact message`, async () => {
      assert.deepEqual(await inspectAudio(fixtureBytes(name)), {ok: false, message});
    });
  }

  it("rejects an empty Blob and an empty Uint8Array", async () => {
    assert.deepEqual(await inspectAudio(new Uint8Array(0)), {ok: false, message: AUDIO_EMPTY_MESSAGE});
    assert.deepEqual(await inspectAudio(new Blob([])), {ok: false, message: AUDIO_EMPTY_MESSAGE});
  });

  it("rejects a few bytes that start like a container but are cut short", async () => {
    const result = await inspectAudio(fixtureBytes("tone-220-10s.wav").subarray(0, 20));

    assert.equal(result.ok, false);
    assert.ok(result.message.length > 0);
  });
});

const info = (overrides = {}) => ({
  container: "wave",
  videoTrackCount: 0,
  audioTracks: [{codec: "pcm-s16", sampleRate: 48_000, channels: 2}],
  durationSeconds: 5,
  ...overrides,
});
const track = (overrides) => ({codec: "pcm-s16", sampleRate: 48_000, channels: 2, ...overrides});
const via = (raw) => inspectAudio(new Uint8Array(8), {readInfo: async () => raw});
const messageOf = async (raw) => {
  const result = await via(raw);

  assert.equal(result.ok, false, JSON.stringify(result));

  return result.message;
};

describe("inspectAudio rules (injected reader)", () => {
  it("rejects by byte size before the reader is called", async () => {
    let calls = 0;
    const readInfo = async () => {
      calls += 1;
      return info();
    };

    assert.deepEqual(await inspectAudio(new Uint8Array(0), {readInfo}), {ok: false, message: AUDIO_EMPTY_MESSAGE});
    assert.deepEqual(await inspectAudio(new Uint8Array(MAX_LOCAL_AUDIO_BYTES + 1), {readInfo}), {ok: false, message: AUDIO_TOO_LARGE_MESSAGE});
    assert.equal(calls, 0);
    assert.equal((await inspectAudio(new Uint8Array(MAX_LOCAL_AUDIO_BYTES), {readInfo})).ok, true);
    assert.equal(calls, 1);
  });

  it("applies the rules in the documented order", async () => {
    assert.equal(await messageOf(info({container: null, videoTrackCount: 1})), AUDIO_UNSUPPORTED_MESSAGE);
    assert.equal(await messageOf(info({videoTrackCount: 1, audioTracks: []})), AUDIO_VIDEO_MESSAGE);
    assert.equal(await messageOf(info({audioTracks: []})), AUDIO_TRACKS_MESSAGE);
    assert.equal(await messageOf(info({audioTracks: [track(), track()]})), AUDIO_TRACKS_MESSAGE);
    assert.equal(await messageOf(info({audioTracks: [track({codec: "flac"})], durationSeconds: Number.NaN})), AUDIO_CODEC_MESSAGE);
    assert.equal(await messageOf(info({durationSeconds: Number.NaN, audioTracks: [track({sampleRate: 1, channels: 5})]})), AUDIO_DURATION_UNKNOWN_MESSAGE);
    assert.equal(await messageOf(info({audioTracks: [track({sampleRate: 1, channels: 5})]})), AUDIO_SAMPLE_RATE_MESSAGE);
    assert.equal(await messageOf(info({audioTracks: [track({channels: 5})]})), AUDIO_CHANNELS_MESSAGE);
  });

  it("accepts only the (container, codec) pairs of the spec", async () => {
    const pairs = [
      ["mp3", "mp3", true], ["wave", "pcm-s16", true], ["wave", "pcm-f32", true], ["wave", "pcm-s24", true],
      ["mp4", "aac", true], ["ogg", "opus", true],
      ["mp3", "aac", false], ["wave", "mp3", false], ["wave", "ulaw", false], ["wave", "alaw", false],
      ["mp4", "mp3", false], ["mp4", "flac", false], ["ogg", "flac", false], ["ogg", "aac", false], ["mp3", null, false],
    ];

    for (const [container, codec, ok] of pairs) {
      const result = await via(info({container, audioTracks: [track({codec})]}));

      assert.equal(result.ok, ok, `${container}/${codec}`);

      if (!ok) assert.equal(result.message, AUDIO_CODEC_MESSAGE, `${container}/${codec}`);
    }
  });

  it("rejects Ogg Vorbis with the Vorbis message (no Vorbis fixture can be produced)", async () => {
    assert.deepEqual(await via(info({container: "ogg", audioTracks: [track({codec: "vorbis"})]})), {ok: false, message: "Ogg Vorbis audio is not supported. Use MP3, WAV, M4A or Ogg Opus."});
    assert.equal(AUDIO_VORBIS_MESSAGE, "Ogg Vorbis audio is not supported. Use MP3, WAV, M4A or Ogg Opus.");
  });

  it("checks the duration: not finite, <= 0 or > 300 s", async () => {
    for (const durationSeconds of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1]) {
      assert.equal(await messageOf(info({durationSeconds})), AUDIO_DURATION_UNKNOWN_MESSAGE, String(durationSeconds));
    }

    assert.equal(await messageOf(info({durationSeconds: 300.0001})), AUDIO_TOO_LONG_MESSAGE);
    assert.equal((await via(info({durationSeconds: 300}))).ok, true);
    assert.equal((await via(info({durationSeconds: 0.005}))).ok, true);
  });

  it("checks the sample rate: a finite integer in [8000, 96000]", async () => {
    for (const sampleRate of [7_999, 96_001, 44_100.5, Number.NaN, Number.POSITIVE_INFINITY, 0, -48_000]) {
      assert.equal(await messageOf(info({audioTracks: [track({sampleRate})]})), AUDIO_SAMPLE_RATE_MESSAGE, String(sampleRate));
    }

    for (const sampleRate of [8_000, 44_100, 96_000]) {
      assert.equal((await via(info({audioTracks: [track({sampleRate})]}))).ok, true, String(sampleRate));
    }
  });

  it("checks the channel count: exactly 1 or 2 (zero, negative, non-integral, more than 2 all fail)", async () => {
    for (const channels of [0, -1, 1.5, 2.0000001, 3, 6, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(await messageOf(info({audioTracks: [track({channels})]})), "Audio must be mono or stereo.", String(channels));
    }

    for (const channels of [1, 2]) {
      assert.equal((await via(info({audioTracks: [track({channels})]}))).metadata.channels, channels);
    }
  });

  it("treats a failing reader as an unsupported file", async () => {
    const result = await inspectAudio(new Uint8Array(8), {readInfo: async () => { throw new Error("boom"); }});

    assert.deepEqual(result, {ok: false, message: AUDIO_UNSUPPORTED_MESSAGE});
  });

  it("evaluateRawAudioInfo returns exactly the AudioMetadata keys", () => {
    const result = evaluateRawAudioInfo(info({container: "mp4", audioTracks: [track({codec: "aac", sampleRate: 44_100, channels: 1})], durationSeconds: 1.5}));

    assert.deepEqual(result, {ok: true, metadata: {container: "mp4", codec: "aac", durationSeconds: 1.5, sampleRate: 44_100, channels: 1}});
  });
});

describe("audio payload helpers", () => {
  it("maps containers to MIME types and staged extensions, never from the file's own type", () => {
    assert.deepEqual(["mp3", "wave", "mp4", "ogg"].map(audioMimeTypeFor), ["audio/mpeg", "audio/wav", "audio/mp4", "audio/ogg"]);
    assert.deepEqual(["mp3", "wave", "mp4", "ogg"].map(audioFileExtensionFor), ["mp3", "wav", "m4a", "ogg"]);
  });

  it("knows the accepted combinations", () => {
    assert.equal(isAcceptedAudioCombination("mp3", "mp3"), true);
    assert.equal(isAcceptedAudioCombination("ogg", "vorbis"), false);
    assert.equal(isAcceptedAudioCombination("mp4", "mp3"), false);
  });
});
