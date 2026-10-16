// Real CLI render of a Story that uses local assets (run with `npm run test:cli-e2e`).
// Needs a browser for Remotion: set TORA_REMOTION_BROWSER_EXECUTABLE where Chrome
// is not discoverable (CI sets it to /usr/bin/google-chrome).

import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {after, before, describe, it} from "node:test";
import {fileURLToPath} from "node:url";
import {inflateSync} from "node:zlib";
import {
  decodeMp4AudioMono,
  goertzelWindows,
} from "./helpers/audioEnvelope.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(repoRoot, "tests", "fixtures", "local-assets");
const storyPath = "stories/ci-local-assets.yaml";
const outputPath = join(repoRoot, "output", "ci-local-assets.mp4");
const remotionCli = join(
  repoRoot,
  "node_modules",
  "@remotion",
  "cli",
  "remotion-cli.js",
);

// A hung Remotion or ffmpeg process must fail the test instead of the CI job.
const SPAWN_TIMEOUT_MS = 5 * 60_000;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Remotion's ffmpeg/ffprobe through the CLI entry with the current Node:
// no `npx` (not spawnable without a shell on Windows).
const remotion = (...args) =>
  spawnSync(process.execPath, [remotionCli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: SPAWN_TIMEOUT_MS,
  });

const renderCli = (localAssetsRoot) =>
  spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/render.ts", storyPath],
    {
      cwd: repoRoot,
      env: {...process.env, TORA_LOCAL_ASSETS_ROOT: localAssetsRoot},
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    },
  );

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** RGB of a 1x1 RGB PNG. For one pixel every PNG filter leaves the bytes unchanged. */
const readSinglePixel = (png) => {
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), "output is a PNG");

  const idat = [];
  let width = 0;
  let height = 0;
  let offset = 8;

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") {
      idat.push(data);
    }

    offset += 12 + length;
  }

  assert.deepEqual([width, height], [1, 1]);

  const raw = inflateSync(Buffer.concat(idat));

  assert.equal(raw.length, 4, "1 filter byte + RGB");

  return [raw[1], raw[2], raw[3]];
};

const near = (actual, expected, tolerance = 40) =>
  actual.every((channel, index) => Math.abs(channel - expected[index]) <= tolerance);

const describePixel = (pixel) => `rgb(${pixel.join(", ")})`;

describe("CLI render with local assets", () => {
  let workDirectory;
  let localAssetsRoot;
  let rendered;

  const samplePixel = async (seconds, x, y) => {
    const framePath = join(
      workDirectory,
      `frame-${String(seconds).replace(".", "_")}-${x}-${y}.png`,
    );
    const result = remotion(
      "ffmpeg",
      "-y",
      "-ss",
      String(seconds),
      "-i",
      outputPath,
      "-vf",
      `crop=8:8:${x}:${y},scale=1:1`,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgb24",
      framePath,
    );

    assert.equal(result.status, 0, result.stderr);

    return readSinglePixel(await readFile(framePath));
  };

  before(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), "tora-cli-e2e-"));
    localAssetsRoot = join(workDirectory, "local-assets");

    // Any filenames work: the files are found by content.
    await mkdir(join(localAssetsRoot, "poses"), {recursive: true});
    await mkdir(join(localAssetsRoot, "backgrounds"), {recursive: true});
    await cp(
      join(fixtureDir, "pose-magenta.png"),
      join(localAssetsRoot, "poses", "my-pose.dat"),
    );
    await cp(
      join(fixtureDir, "background-cyan.jpg"),
      join(localAssetsRoot, "backgrounds", "backdrop"),
    );

    await rm(outputPath, {force: true});
    rendered = renderCli(localAssetsRoot);
  });

  after(async () => {
    if (workDirectory) {
      await rm(workDirectory, {recursive: true, force: true});
    }

    await rm(outputPath, {force: true});
  });

  it("uses the digests of the committed fixtures in the e2e Story", async () => {
    const yaml = await readFile(join(repoRoot, storyPath), "utf8");
    const pose = sha256(await readFile(join(fixtureDir, "pose-magenta.png")));
    const background = sha256(
      await readFile(join(fixtureDir, "background-cyan.jpg")),
    );

    assert.ok(
      yaml.includes(`local:pose:sha256:${pose}`) &&
        yaml.includes(`local:background:sha256:${background}`),
      `${storyPath} must reference the current fixture digests (run \`npm run assets\` against tests/fixtures/local-assets copies and update it)`,
    );
  });

  it("renders the Story from local-assets and exits 0", async () => {
    assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
    assert.match(rendered.stdout, /Rendered .*ci-local-assets\.mp4/u);
    assert.ok((await stat(outputPath)).size > 0);
  });

  it("produces h264, 1080x1920, 30 fps, 2 seconds", () => {
    const result = remotion(
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,r_frame_rate:format=duration",
      "-of",
      "json",
      outputPath,
    );

    assert.equal(result.status, 0, result.stderr);

    const probe = JSON.parse(result.stdout);
    const [video] = probe.streams;

    assert.equal(video.codec_name, "h264");
    assert.equal(video.width, 1080);
    assert.equal(video.height, 1920);
    assert.equal(video.r_frame_rate, "30/1");
    assert.ok(
      Math.abs(Number(probe.format.duration) - 2) < 0.1,
      `duration ${probe.format.duration}`,
    );
  });

  it("draws the staged originals: magenta pose, cyan and yellow background", async () => {
    const magenta = await samplePixel(0.6, 540, 1280);
    const cyan = await samplePixel(0.6, 540, 600);
    const yellow = await samplePixel(0.6, 100, 1800);

    assert.ok(near(magenta, [255, 0, 255]), describePixel(magenta));
    assert.ok(near(cyan, [0, 220, 220], 60), describePixel(cyan));
    assert.ok(near(yellow, [215, 215, 0], 60), describePixel(yellow));
  });

  it("keeps bundled assets in the control scene", async () => {
    const pose = await samplePixel(1.6, 540, 1280);
    const background = await samplePixel(1.6, 540, 600);
    const corner = await samplePixel(1.6, 100, 1800);

    assert.ok(!near(pose, [255, 0, 255]), describePixel(pose));
    assert.ok(!near(background, [0, 220, 220], 60), describePixel(background));
    assert.ok(!near(corner, [215, 215, 0], 60), describePixel(corner));
  });

  it("fails with an empty local-assets root and leaves no MP4", async () => {
    const emptyRoot = join(workDirectory, "empty-root");

    await mkdir(emptyRoot);

    const result = renderCli(emptyRoot);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot render Story/u);
    await assert.rejects(stat(outputPath), {code: "ENOENT"});
  });
});


describe("CLI render with audio", () => {
  const audioStoryPath = "stories/ci-audio.yaml";
  const audioOutputPath = join(repoRoot, "output", "ci-audio.mp4");
  // A copy of the reference Story under another slug: the test never renders to,
  // or deletes, the developer's own output/friday-deploy.mp4.
  const silentOutputPath = join(repoRoot, "output", "ci-audio-silent.mp4");
  let workDirectory;
  let emptyRoot;
  let audioRender;
  let probe;

  const render = (story, localAssetsRoot) =>
    spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/render.ts", story],
      {
        cwd: repoRoot,
        env: {...process.env, TORA_LOCAL_ASSETS_ROOT: localAssetsRoot},
        encoding: "utf8",
        timeout: SPAWN_TIMEOUT_MS,
      },
    );
  const probeStreams = (path) => {
    const result = remotion(
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name,profile,width,height,r_frame_rate,sample_rate,channels,bit_rate,duration,nb_frames",
      "-of",
      "json",
      path,
    );

    assert.equal(result.status, 0, result.stderr);

    return JSON.parse(result.stdout).streams;
  };

  before(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), "tora-cli-audio-e2e-"));
    emptyRoot = join(workDirectory, "local-assets");
    await mkdir(emptyRoot);
    await rm(audioOutputPath, {force: true});
    audioRender = render(audioStoryPath, emptyRoot);
    probe = audioRender.status === 0 ? probeStreams(audioOutputPath) : [];
  });

  after(async () => {
    if (workDirectory) {
      await rm(workDirectory, {recursive: true, force: true});
    }

    await rm(audioOutputPath, {force: true});
    await rm(silentOutputPath, {force: true});
  });

  it("renders the Story with a bundled sfx from the staged copy and exits 0", async () => {
    assert.equal(audioRender.status, 0, audioRender.stderr || audioRender.stdout);
    assert.match(audioRender.stdout, /Rendered .*ci-audio\.mp4/u);
    assert.ok((await stat(audioOutputPath)).size > 0);
  });

  it("outputs h264 1080x1920 30 fps with 360 frames and one AAC-LC 48 kHz stereo stream at about 128 kb/s", () => {
    const video = probe.filter((stream) => stream.codec_type === "video");
    const audio = probe.filter((stream) => stream.codec_type === "audio");

    assert.equal(video.length, 1);
    assert.equal(video[0].codec_name, "h264");
    assert.deepEqual([video[0].width, video[0].height], [1080, 1920]);
    assert.equal(video[0].r_frame_rate, "30/1");
    assert.equal(Number(video[0].nb_frames), 360);

    assert.equal(audio.length, 1);
    assert.equal(audio[0].codec_name, "aac");
    // The repository ffprobe prints the AAC profile as its number (1 = LC).
    assert.ok(["LC", "1"].includes(audio[0].profile), `profile ${audio[0].profile}`);
    assert.equal(Number(audio[0].sample_rate), 48_000);
    assert.equal(audio[0].channels, 2);

    const bitRate = Number(audio[0].bit_rate);

    assert.ok(bitRate >= 115_200 && bitRate <= 140_800, `bit rate ${bitRate}`);

    // 1 / fps plus the 60 ms the spec allows for the encoder's priming.
    const drift = Math.abs(Number(audio[0].duration) - Number(video[0].duration));

    assert.ok(drift <= 1 / 30 + 0.06, `audio ${audio[0].duration} s, video ${video[0].duration} s`);
  });

  it("plays the ding at the scene start and nothing after it (Goertzel on the decoded MP4)", async () => {
    const samples = await decodeMp4AudioMono(audioOutputPath);
    const fundamental = goertzelWindows(samples, 880, 100);
    const partial = goertzelWindows(samples, 1760, 100);

    // Positive control: the sfx is clearly there in the first 300 ms...
    for (const windows of [fundamental, partial]) {
      assert.ok(windows[0] > 0.02 && windows[1] > 0.02, windows.slice(0, 3).join(" "));
    }

    // ...it decays, and nothing sounds from 2 s on (the Story has no other audio).
    for (const windows of [fundamental, partial]) {
      assert.ok(
        windows.slice(20).every((amplitude) => amplitude < 0.005),
        `after 2 s: ${Math.max(...windows.slice(20))}`,
      );
    }
  });

  it("fails before spawning Remotion on a truncated local voice and leaves no MP4", async () => {
    const root = join(workDirectory, "truncated-root");
    const truncated = await readFile(
      join(repoRoot, "tests", "fixtures", "local-audio", "truncated.mp3"),
    );
    const slug = "ci-audio-truncated";
    const story = join(workDirectory, `${slug}.yaml`);

    await mkdir(join(root, "audio"), {recursive: true});
    await cp(
      join(repoRoot, "tests", "fixtures", "local-audio", "truncated.mp3"),
      join(root, "audio", "voice.mp3"),
    );
    await writeFile(
      story,
      [
        'title: "CI truncated voice"',
        "scenes:",
        "  - type: intro",
        "    pose: formal",
        "    background: office",
        '    text: "Truncated."',
        "    voice:",
        `      src: local:audio:sha256:${sha256(truncated)}`,
        "    duration: auto",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = render(story, root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Audio file voice\.mp3 cannot be used for rendering/u);
    assert.doesNotMatch(result.stdout, /Rendered \d+\/\d+/u);
    await assert.rejects(stat(join(repoRoot, "output", `${slug}.mp4`)), {code: "ENOENT"});
  });

  it("a Story whose only audio is at volume 0 still gets exactly one AAC-LC stereo track, silent (--enforce-audio-track)", async () => {
    const storyFile = join(workDirectory, "ci-audio-volume-zero.yaml");
    const outputFile = join(repoRoot, "output", "ci-audio-volume-zero.mp4");

    await writeFile(
      storyFile,
      [
        "title: Volume zero",
        "scenes:",
        "  - type: intro",
        "    pose: formal",
        "    background: office",
        "    animation: fade",
        "    text: Sin sonido audible.",
        "    sfx:",
        "      src: ding",
        "      volume: 0",
        "    duration: 2",
        "",
      ].join("\n"),
    );
    await rm(outputFile, {force: true});

    try {
      const result = render(storyFile, emptyRoot);

      assert.equal(result.status, 0, result.stderr || result.stdout);

      const streams = probeStreams(outputFile);
      const audio = streams.filter((stream) => stream.codec_type === "audio");

      assert.equal(streams.filter((stream) => stream.codec_type === "video").length, 1);
      assert.equal(audio.length, 1);
      assert.equal(audio[0].codec_name, "aac");
      assert.equal(audio[0].profile, "1");
      assert.equal(Number(audio[0].sample_rate), 48_000);
      assert.equal(audio[0].channels, 2);

      const samples = await decodeMp4AudioMono(outputFile);

      assert.ok(samples.every((sample) => Math.abs(sample) < 1e-3), "the track is silent");
    } finally {
      await rm(outputFile, {force: true});
    }
  });

  it("a Story without audio (a copy of friday-deploy.yaml) still renders video-only", async () => {
    const silentStoryPath = join(workDirectory, "ci-audio-silent.yaml");

    await writeFile(silentStoryPath, await readFile(join(repoRoot, "stories", "friday-deploy.yaml")));
    await rm(silentOutputPath, {force: true});

    const result = render(silentStoryPath, emptyRoot);

    assert.equal(result.status, 0, result.stderr || result.stdout);

    const streams = probeStreams(silentOutputPath);

    assert.deepEqual(streams.map((stream) => stream.codec_type), ["video"]);
    assert.equal(Number(streams[0].nb_frames), 360);
  });
});
