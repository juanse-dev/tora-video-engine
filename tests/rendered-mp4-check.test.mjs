import assert from "node:assert/strict";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, before, describe, it} from "node:test";
import {fileURLToPath} from "node:url";
import {
  AAC_LC_CODEC_STRING,
  checkMp4Facts,
  readMp4Facts,
  verifyRenderedMp4,
} from "../src/web/renderedMp4Check.ts";
import {runFfmpeg} from "./helpers/ffmpeg.mjs";

const EXPECTED = {frames: 60, fps: 30, width: 1080, height: 1920, hasAudio: true};
const goodFacts = () => ({
  videoTracks: [
    {codec: "avc", width: 1080, height: 1920, packetCount: 60, packetRate: 30, duration: 2},
  ],
  audioTracks: [
    {codecString: "mp4a.40.2", sampleRate: 48_000, channels: 2, averageBitrate: 128_000, duration: 2.02},
  ],
});
const withAudio = (patch) => {
  const facts = goodFacts();

  facts.audioTracks[0] = {...facts.audioTracks[0], ...patch};

  return facts;
};
const withVideo = (patch) => {
  const facts = goodFacts();

  facts.videoTracks[0] = {...facts.videoTracks[0], ...patch};

  return facts;
};

describe("checkMp4Facts: the planned MP4 of a Story with audio", () => {
  it("accepts H.264 1080x1920 30 FPS with the planned frame count and AAC-LC 48 kHz stereo at about 128 kb/s", () => {
    assert.equal(AAC_LC_CODEC_STRING, "mp4a.40.2");
    assert.equal(checkMp4Facts(goodFacts(), EXPECTED), null);
  });

  it("rejects HE-AAC (mp4a.40.5 and mp4a.40.29)", () => {
    for (const codecString of ["mp4a.40.5", "mp4a.40.29"]) {
      assert.match(
        checkMp4Facts(withAudio({codecString}), EXPECTED),
        new RegExp(`its audio is ${codecString.replaceAll(".", "\\.")}, not AAC-LC`, "u"),
      );
    }

    assert.match(checkMp4Facts(withAudio({codecString: null}), EXPECTED), /unknown, not AAC-LC/u);
  });

  it("only requires the audio to carry data: any bitrate above 0 passes (the WASM AAC encoder writes 67-89 kb/s, accepted by D-13)", () => {
    for (const averageBitrate of [1, 64_000, 67_000, 89_000, 128_000, 317_000]) {
      assert.equal(checkMp4Facts(withAudio({averageBitrate}), EXPECTED), null, String(averageBitrate));
    }

    for (const averageBitrate of [0, -1, Number.NaN]) {
      assert.match(
        checkMp4Facts(withAudio({averageBitrate}), EXPECTED),
        /its audio track carries no data/u,
        String(averageBitrate),
      );
    }
  });

  it("rejects another sample rate, mono, and an audio that ends more than a frame plus 60 ms after the video", () => {
    assert.match(checkMp4Facts(withAudio({sampleRate: 44_100}), EXPECTED), /44100 Hz, not 48000 Hz/u);
    assert.match(checkMp4Facts(withAudio({channels: 1}), EXPECTED), /1 channels, not stereo/u);
    assert.equal(checkMp4Facts(withAudio({duration: 2 + 1 / 30 + 0.05}), EXPECTED), null);
    assert.match(checkMp4Facts(withAudio({duration: 2 + 1 / 30 + 0.07}), EXPECTED), /long and its video/u);
    assert.match(checkMp4Facts(withAudio({duration: 1.8}), EXPECTED), /long and its video/u);
  });

  it("fails closed on a duration that is NaN, Infinity, zero or negative (a NaN difference would pass every tolerance test)", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1]) {
      assert.match(
        checkMp4Facts(withAudio({duration: bad}), EXPECTED),
        /is not a valid duration/u,
        `audio ${bad}`,
      );
      assert.match(
        checkMp4Facts(withVideo({duration: bad}), EXPECTED),
        /is not a valid duration/u,
        `video ${bad}`,
      );
    }

    assert.match(checkMp4Facts(withAudio({duration: Number.NaN}), EXPECTED), /audio length \(NaN\)/u);
    assert.match(checkMp4Facts(withVideo({duration: Number.NaN}), EXPECTED), /video length \(NaN\)/u);
  });

  it("fails closed on every other number the file can give as NaN or Infinity", () => {
    const nan = Number.NaN;

    assert.notEqual(checkMp4Facts(withVideo({width: nan}), EXPECTED), null);
    assert.notEqual(checkMp4Facts(withVideo({height: nan}), EXPECTED), null);
    assert.notEqual(checkMp4Facts(withVideo({packetCount: nan}), EXPECTED), null);
    assert.match(checkMp4Facts(withVideo({packetRate: nan}), EXPECTED), /NaN FPS, not 30/u);
    assert.match(checkMp4Facts(withVideo({packetRate: Number.POSITIVE_INFINITY}), EXPECTED), /FPS, not 30/u);
    assert.notEqual(checkMp4Facts(withAudio({sampleRate: nan}), EXPECTED), null);
    assert.notEqual(checkMp4Facts(withAudio({channels: nan}), EXPECTED), null);
    assert.match(checkMp4Facts(withAudio({averageBitrate: nan}), EXPECTED), /carries no data/u);
    assert.match(checkMp4Facts(withAudio({averageBitrate: Number.POSITIVE_INFINITY}), EXPECTED), /carries no data/u);
    assert.match(checkMp4Facts(withAudio({averageBitrate: 0}), EXPECTED), /carries no data/u);
  });

  it("keeps the video checks: codec, size, frame count, frame rate", () => {
    assert.match(checkMp4Facts(withVideo({codec: "vp9"}), EXPECTED), /vp9, not H\.264/u);
    assert.match(checkMp4Facts(withVideo({width: 1920, height: 1080}), EXPECTED), /1920x1080, not 1080x1920/u);
    assert.match(checkMp4Facts(withVideo({packetCount: 59}), EXPECTED), /59 frames, not 60/u);
    assert.match(checkMp4Facts(withVideo({packetRate: 24}), EXPECTED), /24\.00 FPS, not 30/u);
  });

  it("rejects a missing audio track, a second audio track and a second video track", () => {
    const none = {...goodFacts(), audioTracks: []};
    const two = {...goodFacts(), audioTracks: [goodFacts().audioTracks[0], goodFacts().audioTracks[0]]};
    const videos = {...goodFacts(), videoTracks: [goodFacts().videoTracks[0], goodFacts().videoTracks[0]]};

    assert.match(checkMp4Facts(none, EXPECTED), /0 audio tracks, not 1/u);
    assert.match(checkMp4Facts(two, EXPECTED), /2 audio tracks, not 1/u);
    assert.match(checkMp4Facts(videos, EXPECTED), /2 video tracks, not 1/u);
  });

  it("without audio the check is the v0.3 one: no audio track", () => {
    const silent = {...EXPECTED, hasAudio: false};

    assert.equal(checkMp4Facts({...goodFacts(), audioTracks: []}, silent), null);
    assert.match(checkMp4Facts(goodFacts(), silent), /has an audio track and the Story has no audio/u);
  });
});

describe("verifyRenderedMp4", () => {
  it("resolves for the planned file and throws a sentence naming the problem otherwise", async () => {
    await verifyRenderedMp4(new Blob(["x"]), EXPECTED, {readFacts: async () => goodFacts()});
    await assert.rejects(
      verifyRenderedMp4(new Blob(["x"]), EXPECTED, {
        readFacts: async () => withAudio({codecString: "mp4a.40.5"}),
      }),
      /^Error: The rendered MP4 is not the planned one: its audio is mp4a\.40\.5, not AAC-LC \(mp4a\.40\.2\)\.$/u,
    );
  });

  it("says so, with the planned-file prefix and the reader's message, when the bytes are not an MP4", async () => {
    await assert.rejects(
      verifyRenderedMp4(new Blob(["x"]), EXPECTED, {
        readFacts: async () => {
          throw new Error("moov box missing");
        },
      }),
      /^Error: The rendered MP4 is not the planned one: it could not be read \(moov box missing\)\.$/u,
    );
    await assert.rejects(
      verifyRenderedMp4(new Blob(["not an mp4 at all"]), EXPECTED),
      /^Error: The rendered MP4 is not the planned one: it could not be read \(.+\)\.$/u,
    );
  });
});

describe("readMp4Facts on real MP4 files", () => {
  let directory;
  const clip = {};

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "tora-mp4-check-"));

    // 2 s of the 1080x1920 background fixture at 30 FPS with a 440 Hz AAC track.
    for (const bitrate of ["128k", "64k"]) {
      clip[bitrate] = join(directory, `clip-${bitrate}.mp4`);
      await runFfmpeg([
        "-v", "error",
        "-loop", "1", "-framerate", "30", "-t", "2",
        "-i", fileURLToPath(new URL("./fixtures/local-assets/background-cyan.jpg", import.meta.url)),
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000",
        "-vf", "scale=1080:1920,format=yuv420p", "-r", "30",
        "-c:v", "libx264", "-c:a", "aac", "-b:a", bitrate, "-ac", "2", "-shortest",
        "-y", clip[bitrate],
      ]);
    }
  });
  after(async () => {
    await rm(directory, {recursive: true, force: true});
  });

  it("reads the tracks of a 128 kb/s clip and accepts it as the planned file", async () => {
    const facts = await readMp4Facts(new Blob([await readFile(clip["128k"])]));

    assert.deepEqual(facts.videoTracks.map((v) => [v.codec, v.width, v.height, v.packetCount]), [
      ["avc", 1080, 1920, 60],
    ]);
    assert.equal(facts.audioTracks.length, 1);
    assert.equal(facts.audioTracks[0].codecString, "mp4a.40.2");
    assert.equal(facts.audioTracks[0].sampleRate, 48_000);
    assert.equal(facts.audioTracks[0].channels, 2);
    assert.ok(facts.audioTracks[0].averageBitrate > 110_000 && facts.audioTracks[0].averageBitrate < 150_000);
    assert.equal(checkMp4Facts(facts, EXPECTED), null);
  });

  it("accepts the real 64 kb/s clip (no bitrate range), and rejects a clip with another frame count", async () => {
    const facts = await readMp4Facts(new Blob([await readFile(clip["64k"])]));

    assert.ok(facts.audioTracks[0].averageBitrate > 50_000 && facts.audioTracks[0].averageBitrate < 80_000);
    assert.equal(checkMp4Facts(facts, EXPECTED), null);
    assert.match(
      checkMp4Facts(await readMp4Facts(new Blob([await readFile(clip["128k"])])), {...EXPECTED, frames: 90}),
      /60 frames, not 90/u,
    );
  });

  it("fails on bytes that are not an MP4", async () => {
    await assert.rejects(readMp4Facts(new Blob(["not an mp4 at all"])));
  });
});
