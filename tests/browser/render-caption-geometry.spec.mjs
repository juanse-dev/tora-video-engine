import {expect, test} from "@playwright/test";
import {
  decodeMp4Frame,
  isBrowserRenderSupported,
  waitForOwner,
} from "./helpers/localAssetPage.mjs";
import {importSingleScene} from "./helpers/singleScene.mjs";

// Encoded caption geometry: renders one-scene Stories to MP4 in the browser and
// checks the caption lines in the decoded frame against the preview's layout.
//
// Bundled Chromium cannot encode H.264, so this file runs only under
// playwright.browser-render.config.mjs (system Chrome) and is ignored by the
// default config. There a missing render capability is a failure, not a skip:
// the spec must never pass vacuously.

const DECODED_FRAME_WIDTH = 540;
const DECODED_FRAME_HEIGHT = 960;
const RGB_CHANNELS = 3;

const renderCurrentStoryToPath = async (page) => {
  const renderButton = page.getByRole("button", {name: "Render MP4"});
  const downloadPromise = page.waitForEvent("download", {
    timeout: 120_000,
  });

  await renderButton.click();
  const download = await downloadPromise;
  const path = await download.path();

  if (path === null) {
    throw new Error("Expected browser MP4 download path");
  }

  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-render-state",
    "success",
    {timeout: 30_000},
  );
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-authoring-locked",
    "false",
  );

  return path;
};

const getCaptionExpectation = async (page) => {
  const caption = page.locator(".preview-frame [data-caption-align]").first();
  await expect(caption).toBeVisible();

  const lines = caption.locator("[data-caption-line]");
  const lineCount = await lines.count();
  const frame = caption.locator("[data-caption-frame]");

  const geometry = await frame.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return {
      fontFamily: style.fontFamily,
      fontSize: Number.parseFloat(style.fontSize),
      height: rect.height,
      width: rect.width,
      lineBoxes: [
        ...element.querySelectorAll("[data-caption-line]"),
      ].map((line) => {
        const lineRect = line.getBoundingClientRect();

        return {
          topRatio: (lineRect.top - rect.top) / rect.height,
          heightRatio: lineRect.height / rect.height,
        };
      }),
    };
  });

  return {
    align: await caption.getAttribute("data-caption-align"),
    frameHeight:
      (geometry.height / geometry.width) *
      936 *
      0.5,
    fontFamily: geometry.fontFamily,
    fontSize: geometry.fontSize,
    lineCount,
    lineBoxes: geometry.lineBoxes,
  };
};

// One band of bright text rows per caption line. The line windows come from
// the DOM line boxes (split halfway between neighbouring boxes) instead of from
// gaps in the ink: caption lines are set tight, and how many empty rows
// separate a descender from the next line's ascenders depends on the platform
// glyph rasterizer (2 rows under Windows Chrome, so a "gap of 3 or less joins
// the bands" scan reads 7 lines as 4). A descender that crosses a boundary
// counts towards the next window; the height limits below have room for it.
const brightTextBands = (
  frame,
  {x, y, width, height},
  boundaries,
) => {
  const edges = [y, ...boundaries, y + height];

  return edges.slice(0, -1).map((windowStart, line) => {
    const windowEnd = edges[line + 1];
    let first = null;
    let last = null;

    for (
      let py = Math.max(y, Math.round(windowStart));
      py < Math.min(y + height, Math.round(windowEnd));
      py += 1
    ) {
      let brightPixels = 0;

      for (let px = x; px < x + width; px += 1) {
        const index =
          (py * DECODED_FRAME_WIDTH + px) * RGB_CHANNELS;
        const luminance =
          frame[index] * 0.2126 +
          frame[index + 1] * 0.7152 +
          frame[index + 2] * 0.0722;

        if (luminance > 150) {
          brightPixels += 1;
        }
      }

      if (brightPixels >= 3) {
        first ??= py;
        last = py;
      }
    }

    return first === null ? null : {start: first, end: last};
  });
};

const brightBoundsForBand = (
  frame,
  band,
  {x, width},
) => {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let brightPixels = 0;

  for (let py = band.start; py <= band.end; py += 1) {
    for (let px = x; px < x + width; px += 1) {
      const index =
        (py * DECODED_FRAME_WIDTH + px) * RGB_CHANNELS;
      const luminance =
        frame[index] * 0.2126 +
        frame[index + 1] * 0.7152 +
        frame[index + 2] * 0.0722;

      if (luminance > 150) {
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        brightPixels += 1;
      }
    }
  }

  if (brightPixels === 0) {
    throw new Error("Expected bright caption pixels");
  }

  return {minX, maxX, brightPixels};
};

const assertEncodedCaptionGeometry = ({
  frame,
  expectation,
  placement,
}) => {
  const frameX = 36;
  const frameWidth = 468;
  const frameY =
    placement === "top"
      ? 48
      : Math.round(
          DECODED_FRAME_HEIGHT -
            48 -
            expectation.frameHeight,
        );
  const frameHeight = Math.round(expectation.frameHeight);
  const scan = {
    x: frameX + 8,
    y: frameY + 4,
    width: frameWidth - 16,
    height: Math.max(1, frameHeight - 8),
  };
  expect(expectation.fontFamily).toMatch(/Inter/i);
  expect(expectation.lineCount).toBeGreaterThan(1);
  expect(expectation.lineBoxes).toHaveLength(expectation.lineCount);

  const boundaries = expectation.lineBoxes
    .slice(1)
    .map(
      (box, index) =>
        frameY +
        ((expectation.lineBoxes[index].topRatio +
          expectation.lineBoxes[index].heightRatio +
          box.topRatio) /
          2) *
          expectation.frameHeight,
    );
  const bands = brightTextBands(frame, scan, boundaries);

  // Each DOM line window holds encoded text. The windows run to the midpoint
  // between neighbouring line boxes, so a whole-block shift of less than half
  // a line pitch still passes here; the per-line golden (assertEncodedCaption
  // in browser-render-golden.spec.mjs) checks exact positions.
  expect(bands.every((band) => band !== null)).toBe(true);

  const bounds = bands.map((band) =>
    brightBoundsForBand(frame, band, {
      x: scan.x,
      width: scan.width,
    }),
  );

  for (const band of bands) {
    const height = band.end - band.start + 1;

    expect(height).toBeGreaterThan(
      Math.max(8, expectation.fontSize * 0.16),
    );
    expect(height).toBeLessThan(
      expectation.fontSize * 0.65,
    );
  }

  const rightPaddingStart = frameX + frameWidth - 12;
  expect(
    bounds.every(({maxX}) => maxX < rightPaddingStart),
  ).toBe(true);

  if (expectation.align === "center") {
    for (const {minX, maxX} of bounds) {
      expect(
        Math.abs((minX + maxX) / 2 - DECODED_FRAME_WIDTH / 2),
      ).toBeLessThan(22);
    }
  } else {
    const leftEdges = bounds.map(({minX}) => minX);
    const edgeSpread =
      Math.max(...leftEdges) - Math.min(...leftEdges);

    expect(Math.min(...leftEdges)).toBeLessThan(70);
    expect(edgeSpread).toBeLessThan(6);
  }
};

test("encoded browser render preserves long natural and hard-wrap caption geometry", async ({
  page,
}) => {
  test.setTimeout(240_000);

  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  expect(
    await isBrowserRenderSupported(page),
    `Browser MP4 rendering must be ready in this runtime: ${await page
      .locator(".render-banner")
      .textContent()}`,
  ).toBe(true);

  const natural =
    "A long natural language caption keeps wrapping explicit and deterministic across the encoded browser renderer without relying on CSS word breaking.";
  await importSingleScene(page, {
    type: "intro",
    text: natural,
    duration: 1,
  });
  const naturalExpectation = await getCaptionExpectation(page);
  expect(naturalExpectation.align).toBe("center");

  const naturalPath = await renderCurrentStoryToPath(page);
  const naturalFrame = await decodeMp4Frame(naturalPath, 0.5);
  assertEncodedCaptionGeometry({
    frame: naturalFrame,
    expectation: naturalExpectation,
    placement: "top",
  });

  const hardToken = "W".repeat(120);
  await importSingleScene(page, {
    type: "dialogue",
    text: hardToken,
    duration: 1,
    pose: "confused",
  });
  const hardExpectation = await getCaptionExpectation(page);
  expect(hardExpectation.align).toBe("left");

  const hardPath = await renderCurrentStoryToPath(page);
  const hardFrame = await decodeMp4Frame(hardPath, 0.5);
  assertEncodedCaptionGeometry({
    frame: hardFrame,
    expectation: hardExpectation,
    placement: "bottom",
  });
});
