import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {existsSync} from "node:fs";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {after, before, describe, it} from "node:test";
import {fileURLToPath} from "node:url";
import {
  compositorPackageName,
  decodeFrame,
  probeMp4,
  resolveFfmpegBinaries,
} from "./helpers/ffmpeg.mjs";

const fixtureDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "local-assets",
);

describe("compositorPackageName", () => {
  const cases = [
    [{platform: "win32", arch: "x64"}, "compositor-win32-x64-msvc"],
    [{platform: "darwin", arch: "arm64"}, "compositor-darwin-arm64"],
    [{platform: "darwin", arch: "x64"}, "compositor-darwin-x64"],
    [
      {platform: "linux", arch: "x64", musl: false},
      "compositor-linux-x64-gnu",
    ],
    [
      {platform: "linux", arch: "x64", musl: true},
      "compositor-linux-x64-musl",
    ],
    [
      {platform: "linux", arch: "arm64", musl: false},
      "compositor-linux-arm64-gnu",
    ],
    [
      {platform: "linux", arch: "arm64", musl: true},
      "compositor-linux-arm64-musl",
    ],
  ];

  for (const [input, expected] of cases) {
    it(`maps ${JSON.stringify(input)} to ${expected}`, () => {
      assert.equal(compositorPackageName(input), `@remotion/${expected}`);
    });
  }

  it("rejects unsupported platforms and architectures", () => {
    assert.throws(
      () => compositorPackageName({platform: "freebsd", arch: "x64"}),
      /Unsupported platform freebsd/u,
    );
    assert.throws(
      () => compositorPackageName({platform: "win32", arch: "arm64"}),
      /Unsupported architecture arm64 on win32/u,
    );
  });
});

describe("resolveFfmpegBinaries", () => {
  it("finds the installed ffmpeg and ffprobe without npx", () => {
    const {ffmpeg, ffprobe} = resolveFfmpegBinaries();

    assert.ok(existsSync(ffmpeg), ffmpeg);
    assert.ok(existsSync(ffprobe), ffprobe);
    assert.match(ffmpeg, /compositor-/u);
  });

  it("says which package is missing", () => {
    assert.throws(
      () =>
        resolveFfmpegBinaries({
          platform: "linux",
          arch: "x64",
          musl: false,
          resolvePackage: () => {
            throw new Error("Cannot find module");
          },
        }),
      /@remotion\/compositor-linux-x64-gnu/u,
    );
  });
});

describe("probeMp4 and decodeFrame", () => {
  let workDirectory;
  let silent;
  let withAudio;

  const encode = (output, extraInputs, extraOutputArgs) => {
    const {ffmpeg} = resolveFfmpegBinaries();

    // A 1 second, 30 fps clip of the cyan-over-yellow fixture, 108x192.
    execFileSync(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-loop",
        "1",
        "-framerate",
        "30",
        "-t",
        "1",
        "-i",
        join(fixtureDir, "background-cyan.jpg"),
        ...extraInputs,
        "-vf",
        "scale=108:192,format=yuv420p",
        "-c:v",
        "libx264",
        ...extraOutputArgs,
        "-y",
        output,
      ],
      {stdio: "pipe"},
    );
  };

  before(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), "tora-ffmpeg-test-"));
    silent = join(workDirectory, "silent.mp4");
    withAudio = join(workDirectory, "audio.mp4");
    encode(silent, [], []);
    encode(
      withAudio,
      ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono"],
      ["-c:a", "aac", "-shortest"],
    );
  });

  after(async () => {
    await rm(workDirectory, {recursive: true, force: true});
  });

  it("reports codec, size, fps, frames, audio and duration", async () => {
    const info = await probeMp4(silent);

    assert.equal(info.codec, "h264");
    assert.equal(info.width, 108);
    assert.equal(info.height, 192);
    assert.equal(info.fps, 30);
    assert.equal(info.frames, 30);
    assert.equal(info.hasAudio, false);
    assert.ok(Math.abs(info.durationSeconds - 1) < 0.05, String(info));
  });

  it("detects an audio stream", async () => {
    assert.equal((await probeMp4(withAudio)).hasAudio, true);
  });

  it("rejects files that are not videos", async () => {
    const notVideo = join(workDirectory, "not-video.mp4");

    await writeFile(notVideo, "plain text, not an mp4");
    await assert.rejects(() => probeMp4(notVideo), /probeMp4/u);
    await assert.rejects(
      () => probeMp4(join(workDirectory, "missing.mp4")),
      /probeMp4/u,
    );
  });

  it("decodes a scaled RGB24 frame with the expected colours", async () => {
    const width = 54;
    const height = 96;
    const frame = await decodeFrame(silent, 0.5, {width, height});

    assert.equal(frame.length, width * height * 3);

    const pixel = (x, y) => {
      const index = (y * width + x) * 3;

      return [frame[index], frame[index + 1], frame[index + 2]];
    };
    const [tr, tg, tb] = pixel(27, 20); // top half: cyan
    const [br, bg, bb] = pixel(27, 80); // bottom half: yellow

    assert.ok(tr < 90 && tg > 150 && tb > 150, `top ${[tr, tg, tb]}`);
    assert.ok(br > 150 && bg > 150 && bb < 90, `bottom ${[br, bg, bb]}`);
  });

  it("fails clearly when the time is past the end of the video", async () => {
    await assert.rejects(
      () => decodeFrame(silent, 30, {width: 54, height: 96}),
      /decodeFrame/u,
    );
  });
});
