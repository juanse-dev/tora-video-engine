// The post-render check of a browser MP4 that has audio (AUDIO-005, AINV-9):
// read what the renderer really wrote and refuse to hand over a file that is
// not the planned one. The check runs on the materialized Blob, before the
// download starts. A Story without audio keeps the v0.3 behavior: no check here.

import {ALL_FORMATS, BlobSource, Input} from "mediabunny";
import {OUTPUT_AUDIO_SAMPLE_RATE} from "../audio/constants.ts";

/** AAC-LC. HE-AAC (`mp4a.40.5`, `mp4a.40.29`) fails. */
export const AAC_LC_CODEC_STRING = "mp4a.40.2";
/** The audio may end this much after the video beyond one frame (encoder priming and padding). */
export const AUDIO_DURATION_SLACK_SECONDS = 0.06;

export type Mp4VideoFacts = {
  codec: string | null;
  width: number;
  height: number;
  packetCount: number;
  packetRate: number;
  duration: number;
};

export type Mp4AudioFacts = {
  /** The full codec string of the track, e.g. `mp4a.40.2`. */
  codecString: string | null;
  sampleRate: number;
  channels: number;
  /** Audio packet bytes x 8 / audio duration, from the packet statistics. */
  averageBitrate: number;
  duration: number;
};

export type Mp4Facts = {
  videoTracks: Mp4VideoFacts[];
  audioTracks: Mp4AudioFacts[];
};

export type RenderedMp4Expectation = {
  /** The plan's total length in frames. */
  frames: number;
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
};

export const readMp4Facts = async (blob: Blob): Promise<Mp4Facts> => {
  const input = new Input({source: new BlobSource(blob), formats: ALL_FORMATS});

  try {
    const videoTracks: Mp4VideoFacts[] = [];
    const audioTracks: Mp4AudioFacts[] = [];

    for (const track of await input.getVideoTracks()) {
      const stats = await track.computePacketStats();

      videoTracks.push({
        codec: await track.getCodec(),
        width: await track.getCodedWidth(),
        height: await track.getCodedHeight(),
        packetCount: stats.packetCount,
        packetRate: stats.averagePacketRate,
        duration: await track.computeDuration(),
      });
    }

    for (const track of await input.getAudioTracks()) {
      const stats = await track.computePacketStats();

      audioTracks.push({
        codecString: await track.getCodecParameterString(),
        sampleRate: await track.getSampleRate(),
        channels: await track.getNumberOfChannels(),
        averageBitrate: stats.averageBitrate,
        duration: await track.computeDuration(),
      });
    }

    return {videoTracks, audioTracks};
  } finally {
    input.dispose();
  }
};

const isUsableDuration = (seconds: number): boolean =>
  Number.isFinite(seconds) && seconds > 0;

/** The first thing wrong with the facts, as a sentence, or null when the file is the planned one. */
export const checkMp4Facts = (
  facts: Mp4Facts,
  expected: RenderedMp4Expectation,
): string | null => {
  if (facts.videoTracks.length !== 1) {
    return `it has ${facts.videoTracks.length} video tracks, not 1`;
  }

  const [video] = facts.videoTracks;

  if (video.codec !== "avc") {
    return `its video is ${video.codec ?? "unknown"}, not H.264`;
  }

  if (video.width !== expected.width || video.height !== expected.height) {
    return `its video is ${video.width}x${video.height}, not ${expected.width}x${expected.height}`;
  }

  if (video.packetCount !== expected.frames) {
    return `its video has ${video.packetCount} frames, not ${expected.frames}`;
  }

  // Every comparison below is written so that NaN and Infinity (a track whose
  // numbers mediabunny could not read) fail it: a plain `> limit` is false for NaN.
  if (!(Math.abs(video.packetRate - expected.fps) <= 0.5)) {
    return `its video runs at ${video.packetRate.toFixed(2)} FPS, not ${expected.fps}`;
  }

  if (!expected.hasAudio) {
    return facts.audioTracks.length === 0 ? null : "it has an audio track and the Story has no audio";
  }

  if (facts.audioTracks.length !== 1) {
    return `it has ${facts.audioTracks.length} audio tracks, not 1`;
  }

  const [audio] = facts.audioTracks;

  if (audio.codecString !== AAC_LC_CODEC_STRING) {
    return `its audio is ${audio.codecString ?? "unknown"}, not AAC-LC (${AAC_LC_CODEC_STRING})`;
  }

  if (audio.sampleRate !== OUTPUT_AUDIO_SAMPLE_RATE) {
    return `its audio is ${audio.sampleRate} Hz, not ${OUTPUT_AUDIO_SAMPLE_RATE} Hz`;
  }

  if (audio.channels !== 2) {
    return `its audio has ${audio.channels} channels, not stereo`;
  }

  // No bitrate range: the WASM AAC encoder ignores the requested 128 kb/s (measured
  // 67-89 kb/s) and D-13 accepts it. The track only has to carry data.
  if (!(Number.isFinite(audio.averageBitrate) && audio.averageBitrate > 0)) {
    return "its audio track carries no data";
  }

  // Both lengths must be real, positive numbers before they are compared: with a
  // NaN the difference is NaN and no tolerance test would ever refuse the file.
  if (!isUsableDuration(audio.duration) || !isUsableDuration(video.duration)) {
    return `its audio length (${audio.duration}) or video length (${video.duration}) is not a valid duration`;
  }

  if (!(Math.abs(audio.duration - video.duration) <= 1 / expected.fps + AUDIO_DURATION_SLACK_SECONDS)) {
    return `its audio is ${audio.duration.toFixed(2)} s long and its video ${video.duration.toFixed(2)} s`;
  }

  return null;
};

/** Throws when the rendered Blob is not the planned MP4. */
export const verifyRenderedMp4 = async (
  blob: Blob,
  expected: RenderedMp4Expectation,
  deps: {readFacts?: (blob: Blob) => Promise<Mp4Facts>} = {},
): Promise<void> => {
  const problem = checkMp4Facts(
    await (deps.readFacts ?? readMp4Facts)(blob),
    expected,
  );

  if (problem !== null) {
    throw new Error(`The rendered MP4 is not the planned one: ${problem}.`);
  }
};
