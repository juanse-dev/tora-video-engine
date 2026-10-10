// MP4 probing and frame decoding for tests, with the ffmpeg/ffprobe binaries
// that ship in the installed @remotion/compositor-* package. No `npx`: it is
// not spawnable without a shell on Windows, and the binaries are called
// directly so the same code works on Windows, macOS and Linux.

import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {chmodSync, statSync} from "node:fs";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {promisify} from "node:util";
import {inflateSync} from "node:zlib";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const PROCESS_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** True when this Linux uses musl rather than glibc (the compositor ships both). */
const detectMusl = () => {
  const report =
    typeof process.report?.getReport === "function"
      ? process.report.getReport()
      : null;

  return report !== null && typeof report === "object"
    ? !report.header?.glibcVersionRuntime
    : false;
};

/**
 * Name of the npm package that holds ffmpeg/ffprobe for a platform, e.g.
 * `@remotion/compositor-win32-x64-msvc` or `@remotion/compositor-linux-x64-gnu`.
 */
export const compositorPackageName = ({
  platform = process.platform,
  arch = process.arch,
  musl,
} = {}) => {
  switch (platform) {
    case "win32":
      if (arch === "x64") {
        return "@remotion/compositor-win32-x64-msvc";
      }

      break;
    case "darwin":
      if (arch === "x64" || arch === "arm64") {
        return `@remotion/compositor-darwin-${arch}`;
      }

      break;
    case "linux":
      if (arch === "x64" || arch === "arm64") {
        const libc = (musl ?? detectMusl()) ? "musl" : "gnu";

        return `@remotion/compositor-linux-${arch}-${libc}`;
      }

      break;
    default:
      throw new Error(
        `Unsupported platform ${platform} (architecture ${arch}) for the Remotion ffmpeg binaries`,
      );
  }

  throw new Error(
    `Unsupported architecture ${arch} on ${platform} for the Remotion ffmpeg binaries`,
  );
};

const executableName = (name, platform) =>
  platform === "win32" ? `${name}.exe` : name;

const ensureExecutable = (path) => {
  if (process.platform === "win32") {
    return;
  }

  try {
    if ((statSync(path).mode & 0o111) === 0) {
      chmodSync(path, 0o755);
    }
  } catch {
    // Let the spawn report the real problem.
  }
};

let cachedBinaries = null;

/**
 * `{dir, ffmpeg, ffprobe}`: absolute paths from the installed compositor
 * package. `resolvePackage` replaces module resolution (tests).
 */
export const resolveFfmpegBinaries = ({
  platform = process.platform,
  arch = process.arch,
  musl,
  resolvePackage = (name) => require.resolve(`${name}/package.json`),
} = {}) => {
  const useCache = platform === process.platform && arch === process.arch;

  if (useCache && musl === undefined && cachedBinaries !== null) {
    return cachedBinaries;
  }

  const packageName = compositorPackageName({platform, arch, musl});
  let packageJson;

  try {
    packageJson = resolvePackage(packageName);
  } catch (error) {
    throw new Error(
      `Could not find ${packageName}, which provides ffmpeg for ${platform}/${arch}. Run npm install. (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const dir = dirname(packageJson);
  const binaries = {
    dir,
    ffmpeg: join(dir, executableName("ffmpeg", platform)),
    ffprobe: join(dir, executableName("ffprobe", platform)),
  };

  if (useCache && musl === undefined) {
    ensureExecutable(binaries.ffmpeg);
    ensureExecutable(binaries.ffprobe);
    cachedBinaries = binaries;
  }

  return binaries;
};

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

/** Decodes an 8-bit, non-interlaced RGB PNG (what ffmpeg writes for rgb24). */
export const decodeRgbPng = (png) => {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);

  assert.deepEqual(
    [png[24], png[25], png[28]],
    [8, 2, 0],
    "PNG must be 8-bit RGB, not interlaced",
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
  const stride = width * 3;
  const out = Buffer.alloc(stride * height);

  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)];
    const source = row * (stride + 1) + 1;

    for (let column = 0; column < stride; column += 1) {
      const left = column >= 3 ? out[row * stride + column - 3] : 0;
      const up = row > 0 ? out[(row - 1) * stride + column] : 0;
      const upLeft =
        row > 0 && column >= 3 ? out[(row - 1) * stride + column - 3] : 0;
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

  return {width, height, pixels: out};
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
