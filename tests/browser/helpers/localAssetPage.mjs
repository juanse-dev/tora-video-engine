import {expect} from "@playwright/test";
import {decodeFrame} from "../../helpers/ffmpeg.mjs";
import {seedAssetLibrary} from "./seedAssetLibrary.mjs";

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

/**
 * RGB24 pixels of one frame, scaled to 540x960, via the ffmpeg binary that
 * ships with Remotion (see tests/helpers/ffmpeg.mjs).
 */
export const decodeMp4Frame = (path, seconds) =>
  decodeFrame(path, seconds, {
    width: DECODED_FRAME_WIDTH,
    height: DECODED_FRAME_HEIGHT,
  });

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

// Regions in the decoded 540x960 frame for the local-asset goldens (the
// browser-render golden and the persistence spec). The intro preset centers
// the pose box (680x802 at bottom 235 in the 1080x1920 frame); the 600x900
// pose is contained in it, so its magenta rectangle (x 150-449, y 225-674)
// lands near x 203-336, y 541-741 here. The regions below stay inside that
// rectangle or in background areas clear of the top caption and of the pose
// rectangle, and away from the cyan/yellow boundary at y = 480.
export const POSE_MAGENTA_REGION = {x: 230, y: 580, width: 80, height: 120};
export const BACKGROUND_TOP_REGION = {x: 20, y: 160, width: 500, height: 280};
export const BACKGROUND_BOTTOM_REGION = {
  x: 20,
  y: 770,
  width: 500,
  height: 170,
};
export const FULL_REGION = {
  x: 0,
  y: 0,
  width: DECODED_FRAME_WIDTH,
  height: DECODED_FRAME_HEIGHT,
};

// Colour predicates for frames decoded with decodeMp4Frame (ffmpeg, RGB24 at
// 540x960) rather than a <video> element: they do not depend on the browser's
// video pipeline, so a black frame means the render is wrong, not the decode.
export const isMagenta = (r, g, b) => r > 180 && g < 90 && b > 180;
export const isCyan = (r, g, b) => r < 90 && g > 150 && b > 150;
export const isYellow = (r, g, b) => r > 150 && g > 150 && b < 90;

/** Share of sampled pixels in `region` of an RGB24 frame matching `predicate`. */
export const regionRatio = (frame, {x, y, width, height}, predicate) => {
  let count = 0;
  let matching = 0;

  for (let py = y; py < y + height; py += 2) {
    for (let px = x; px < x + width; px += 2) {
      const index = (py * DECODED_FRAME_WIDTH + px) * 3;

      count += 1;

      if (predicate(frame[index], frame[index + 1], frame[index + 2])) {
        matching += 1;
      }
    }
  }

  return matching / count;
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
