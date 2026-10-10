import {execFile} from "node:child_process";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import {inflateSync} from "node:zlib";
import {expect} from "@playwright/test";
import {seedAssetLibrary} from "./seedAssetLibrary.mjs";

const execFileAsync = promisify(execFile);

export const DECODED_FRAME_WIDTH = 540;
export const DECODED_FRAME_HEIGHT = 960;

export const waitForOwner = async (page) => {
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-persistence-mode",
    "owner",
    {timeout: 10_000},
  );
};

/** Opens the app once so the origin exists, seeds IndexedDB, then reloads. */
export const openSeeded = async (page, records) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await seedAssetLibrary(page, records);
  await page.reload({waitUntil: "domcontentloaded"});
  await waitForOwner(page);
};

export const applyYaml = async (page, yaml) => {
  const source = page.getByLabel("YAML source");

  if (!(await source.isVisible())) {
    await page.getByRole("button", {name: "Open YAML"}).click();
  }

  await source.fill(yaml);
  await page.getByRole("button", {name: "Apply YAML"}).click();
  await expect(page.locator("[data-yaml-dirty=false]")).toBeVisible();
};

/**
 * Call on a page showing the bundled Story: waits for the render capability
 * check and reports whether browser MP4 rendering works in this runtime
 * (bundled Chromium usually cannot encode H.264).
 */
export const isBrowserRenderSupported = async (page) => {
  const banner = page.locator(".render-banner");

  await expect
    .poll(
      async () =>
        !((await banner.textContent()) ?? "").includes(
          "Checking browser render support",
        ),
      {timeout: 15_000},
    )
    .toBe(true);

  return ((await banner.textContent()) ?? "").includes(
    "Browser MP4 rendering is ready.",
  );
};

/** Decodes an 8-bit, non-interlaced RGB PNG (what ffmpeg writes for rgb24). */
const decodeRgbPng = (png) => {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);

  expect([png[24], png[25], png[28]]).toEqual([8, 2, 0]); // depth, RGB, no interlace

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
 * RGB24 pixels of one frame, scaled to 540x960, via `remotion ffmpeg`. Uses a
 * PNG file as the carrier: the Remotion ffmpeg build has no rawvideo muxer on
 * every platform.
 */
export const decodeMp4Frame = async (path, seconds) => {
  const windows = process.platform === "win32";
  const directory = await mkdtemp(join(tmpdir(), "tora-frame-"));
  const output = join(directory, "frame.png");

  try {
    await execFileAsync(
      windows ? "npx.cmd" : "npx",
      [
        "remotion",
        "ffmpeg",
        "-v",
        "error",
        "-i",
        path,
        "-ss",
        String(seconds),
        "-frames:v",
        "1",
        "-vf",
        `scale=${DECODED_FRAME_WIDTH}:${DECODED_FRAME_HEIGHT}:flags=bilinear`,
        "-pix_fmt",
        "rgb24",
        "-y",
        output,
      ].map((argument) => (windows ? `"${argument}"` : argument)),
      {shell: windows, timeout: 60_000},
    );

    const {width, height, pixels} = decodeRgbPng(await readFile(output));

    expect([width, height]).toEqual([
      DECODED_FRAME_WIDTH,
      DECODED_FRAME_HEIGHT,
    ]);

    return pixels;
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
};

/** Counts clearly magenta pixels (the pose fixture's rectangle). */
export const countMagentaPixels = (frame) => {
  let count = 0;

  for (let index = 0; index < frame.length; index += 3) {
    if (frame[index] > 200 && frame[index + 1] < 60 && frame[index + 2] > 200) {
      count += 1;
    }
  }

  return count;
};

/** Mean luminance, as a positive control that the frame is not all black. */
export const meanLuminance = (frame) => {
  let total = 0;

  for (let index = 0; index < frame.length; index += 3) {
    total +=
      frame[index] * 0.2126 +
      frame[index + 1] * 0.7152 +
      frame[index + 2] * 0.0722;
  }

  return total / (frame.length / 3);
};

/** Names of `__remotion_render:` entries currently in the OPFS root. */
export const listRemotionOpfsEntries = (page) =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names = [];

    for await (const [name] of root.entries()) {
      if (name.startsWith("__remotion_render:")) {
        names.push(name);
      }
    }

    return names;
  });
