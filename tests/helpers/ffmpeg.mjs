// MP4 probing and frame decoding for tests, with the ffmpeg/ffprobe binaries
// that ship in the installed @remotion/compositor-* package. No `npx`: it is
// not spawnable without a shell on Windows, and the binaries are called
// directly so the same code works on Windows, macOS and Linux.

import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import {inflateSync} from "node:zlib";
import {
  compositorPackageName,
  resolveFfmpegBinaries,
} from "../../scripts/ffmpegBinary.mjs";

// The binary lookup lives in scripts/ffmpegBinary.mjs (the CLI audio preflight
// uses it too); the tests keep importing it from here.
export {compositorPackageName, resolveFfmpegBinaries};

const execFileAsync = promisify(execFile);

const PROCESS_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

const run = async (binary, dir, args, options = {}) => {
  const libraryPath = [dir, process.env.LD_LIBRARY_PATH]
    .filter(Boolean)
    .join(":");

  return execFileAsync(binary, args, {
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
    env: {
      ...process.env,
      LD_LIBRARY_PATH: libraryPath,
      DYLD_LIBRARY_PATH: [dir, process.env.DYLD_LIBRARY_PATH]
        .filter(Boolean)
        .join(":"),
    },
    ...options,
  });
};

/** Runs the repository ffmpeg with `args`; resolves `{stdout, stderr}` and rejects on a non-zero exit. */
export const runFfmpeg = (args, options = {}) => {
  const {ffmpeg, dir} = resolveFfmpegBinaries();

  return run(ffmpeg, dir, args, options);
};

const parseRate = (value) => {
  const [numerator, denominator = "1"] = String(value ?? "").split("/");
  const rate = Number(numerator) / Number(denominator);

  return Number.isFinite(rate) ? rate : Number.NaN;
};

/**
 * Facts about an MP4:
 * `{codec, width, height, fps, frames, hasAudio, videoStreams, durationSeconds}`
 * of its first video stream; `videoStreams` is how many video streams the
 * file has. `frames` is counted by decoding (`-count_frames`), not read from
 * the container header.
 */
export const probeMp4 = async (path) => {
  const {ffprobe, dir} = resolveFfmpegBinaries();
  let metadata;

  try {
    const {stdout} = await run(ffprobe, dir, [
      "-v",
      "error",
      "-count_frames",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      path,
    ]);

    metadata = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `probeMp4 could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const streams = metadata.streams ?? [];
  const videoList = streams.filter((stream) => stream.codec_type === "video");
  const video = videoList[0];

  if (video === undefined) {
    throw new Error(`probeMp4: ${path} has no video stream`);
  }

  return {
    codec: video.codec_name,
    width: video.width,
    height: video.height,
    fps: parseRate(video.r_frame_rate ?? video.avg_frame_rate),
    frames: Number(video.nb_read_frames ?? video.nb_frames),
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
    videoStreams: videoList.length,
    durationSeconds: Number(metadata.format?.duration),
  };
};

/** Samples per pixel of the 8-bit PNG colour types ffmpeg writes (RGB, RGBA). */
const PNG_CHANNELS = {2: 3, 6: 4};

/**
 * Decodes an 8-bit, non-interlaced RGB or RGBA PNG (what ffmpeg writes for
 * rgb24 and rgba): `{width, height, channels, pixels}`.
 */
const decodePng8 = (png) => {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = PNG_CHANNELS[png[25]];

  assert.ok(
    png[24] === 8 && channels !== undefined && png[28] === 0,
    "PNG must be 8-bit RGB or RGBA, not interlaced",
  );

  const idat = [];

  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);

    if (type === "IDAT") {
      idat.push(png.subarray(offset + 8, offset + 8 + length));
    }

    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);

  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)];
    const source = row * (stride + 1) + 1;

    for (let column = 0; column < stride; column += 1) {
      const left = column >= channels ? out[row * stride + column - channels] : 0;
      const up = row > 0 ? out[(row - 1) * stride + column] : 0;
      const upLeft =
        row > 0 && column >= channels
          ? out[(row - 1) * stride + column - channels]
          : 0;
      const estimate = left + up - upLeft;
      const paeth = [left, up, upLeft].reduce((best, candidate) =>
        Math.abs(estimate - candidate) < Math.abs(estimate - best)
          ? candidate
          : best,
      );
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter];

      out[row * stride + column] = (raw[source + column] + predictor) & 0xff;
    }
  }

  return {width, height, channels, pixels: out};
};

/** Decodes an 8-bit, non-interlaced RGB PNG (what ffmpeg writes for rgb24). */
export const decodeRgbPng = (png) => {
  assert.equal(png[25], 2, "PNG must be 8-bit RGB, not interlaced");

  const {width, height, pixels} = decodePng8(png);

  return {width, height, pixels};
};

/**
 * RGB24 pixels (a Buffer of width*height*3 bytes) of the frame at `seconds`,
 * scaled to `width` x `height`. Uses a PNG file as the carrier: the Remotion
 * ffmpeg build has no rawvideo muxer on every platform.
 */
export const decodeFrame = async (path, seconds, {width, height}) => {
  const {ffmpeg, dir} = resolveFfmpegBinaries();
  const directory = await mkdtemp(join(tmpdir(), "tora-frame-"));
  const output = join(directory, "frame.png");

  try {
    try {
      await run(ffmpeg, dir, [
        "-v",
        "error",
        "-i",
        path,
        "-ss",
        String(seconds),
        "-frames:v",
        "1",
        "-vf",
        `scale=${width}:${height}:flags=bilinear`,
        "-pix_fmt",
        "rgb24",
        "-y",
        output,
      ]);
    } catch (error) {
      throw new Error(
        `decodeFrame failed on ${path} at ${seconds}s: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let png;

    try {
      png = await readFile(output);
    } catch {
      throw new Error(
        `decodeFrame: no frame at ${seconds}s in ${path} (past the end of the video?)`,
      );
    }

    const decoded = decodeRgbPng(png);

    assert.deepEqual([decoded.width, decoded.height], [width, height]);

    return decoded.pixels;
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
};

/**
 * RGBA pixels (a Buffer of width*height*4 bytes) of an image file (any format
 * ffmpeg reads, such as the bundled palette PNG poses), scaled to `width` x
 * `height` and keeping its alpha channel.
 */
export const decodeImageRgba = async (path, {width, height}) => {
  const {ffmpeg, dir} = resolveFfmpegBinaries();
  const directory = await mkdtemp(join(tmpdir(), "tora-image-"));
  const output = join(directory, "image.png");

  try {
    try {
      await run(ffmpeg, dir, [
        "-v",
        "error",
        "-i",
        path,
        "-frames:v",
        "1",
        "-vf",
        `scale=${width}:${height}:flags=bilinear,format=rgba`,
        "-pix_fmt",
        "rgba",
        "-y",
        output,
      ]);
    } catch (error) {
      throw new Error(
        `decodeImageRgba failed on ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const decoded = decodePng8(await readFile(output));

    assert.deepEqual(
      [decoded.width, decoded.height, decoded.channels],
      [width, height, 4],
    );

    return decoded.pixels;
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
};
