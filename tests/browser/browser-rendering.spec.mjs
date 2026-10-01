import {execFile} from "node:child_process";
import {readFile} from "node:fs/promises";
import {promisify} from "node:util";
import {expect, test} from "@playwright/test";

const execFileAsync = promisify(execFile);

const DECODED_FRAME_WIDTH = 540;
const DECODED_FRAME_HEIGHT = 960;
const RGB_CHANNELS = 3;

const decodeMp4Frame = async (path, seconds) => {
  const {stdout} = await execFileAsync(
    "npx",
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
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    {
      encoding: null,
      maxBuffer:
        DECODED_FRAME_WIDTH *
          DECODED_FRAME_HEIGHT *
          RGB_CHANNELS +
        1024 * 1024,
      timeout: 60_000,
    },
  );

  const frame = Buffer.isBuffer(stdout)
    ? stdout
    : Buffer.from(stdout);

  expect(frame.byteLength).toBe(
    DECODED_FRAME_WIDTH *
      DECODED_FRAME_HEIGHT *
      RGB_CHANNELS,
  );

  return frame;
};

const regionStats = (
  frame,
  {x, y, width, height},
  step = 3,
) => {
  let count = 0;
  let sum = 0;
  let sumSquares = 0;
  let dark = 0;
  let bright = 0;

  for (let py = y; py < y + height; py += step) {
    for (let px = x; px < x + width; px += step) {
      const index =
        (py * DECODED_FRAME_WIDTH + px) * RGB_CHANNELS;
      const luminance =
        frame[index] * 0.2126 +
        frame[index + 1] * 0.7152 +
        frame[index + 2] * 0.0722;

      count += 1;
      sum += luminance;
      sumSquares += luminance * luminance;

      if (luminance < 70) {
        dark += 1;
      }

      if (luminance > 210) {
        bright += 1;
      }
    }
  }

  const mean = sum / count;

  return {
    mean,
    standardDeviation: Math.sqrt(
      Math.max(0, sumSquares / count - mean * mean),
    ),
    darkRatio: dark / count,
    brightRatio: bright / count,
  };
};

const meanAbsoluteFrameDifference = (
  first,
  second,
  {x, y, width, height},
  step = 4,
) => {
  let count = 0;
  let difference = 0;

  for (let py = y; py < y + height; py += step) {
    for (let px = x; px < x + width; px += step) {
      const index =
        (py * DECODED_FRAME_WIDTH + px) * RGB_CHANNELS;

      difference +=
        (Math.abs(first[index] - second[index]) +
          Math.abs(first[index + 1] - second[index + 1]) +
          Math.abs(first[index + 2] - second[index + 2])) /
        RGB_CHANNELS;
      count += 1;
    }
  }

  return difference / count;
};

const captionHorizontalEdgeContrast = (frame, y) => {
  const insideLeft = regionStats(
    frame,
    {x: 42, y, width: 18, height: 18},
    1,
  ).mean;
  const insideRight = regionStats(
    frame,
    {x: 480, y, width: 18, height: 18},
    1,
  ).mean;
  const outsideLeft = regionStats(
    frame,
    {x: 12, y, width: 18, height: 18},
    1,
  ).mean;
  const outsideRight = regionStats(
    frame,
    {x: 510, y, width: 18, height: 18},
    1,
  ).mean;

  return (
    (outsideLeft + outsideRight) / 2 -
    (insideLeft + insideRight) / 2
  );
};

const waitForOwner = async (page) => {
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-persistence-mode",
    "owner",
    {timeout: 10_000},
  );
};

const waitForBrowserRenderAvailability = async (page) => {
  const banner = page.locator(".render-banner");
  const renderButton = page.getByRole("button", {name: "Render MP4"});

  await expect
    .poll(async () => {
      const text = (await banner.textContent()) ?? "";
      const disabled = await renderButton.isDisabled();

      return (
        !text.includes("Checking browser render support") &&
        (!disabled || /unavailable|requires|instead|local CLI/i.test(text))
      );
    }, {timeout: 15_000})
    .toBe(true);

  return !(await renderButton.isDisabled());
};

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
  };
};

const brightTextBands = (
  frame,
  {x, y, width, height},
) => {
  const activeRows = [];

  for (let py = y; py < y + height; py += 1) {
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
      activeRows.push(py);
    }
  }

  const bands = [];

  for (const row of activeRows) {
    const previous = bands.at(-1);

    if (previous && row - previous.end <= 3) {
      previous.end = row;
      continue;
    }

    bands.push({start: row, end: row});
  }

  return bands;
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
  const bands = brightTextBands(frame, scan);

  expect(expectation.fontFamily).toMatch(/Inter/i);
  expect(expectation.lineCount).toBeGreaterThan(1);
  expect(bands).toHaveLength(expectation.lineCount);

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

const importSingleScene = async (page, {
  type,
  text,
  duration = 1,
  pose = "formal",
  background = "office",
}) => {
  const source = [
    "title: Browser render fixture",
    "scenes:",
    `  - type: ${type}`,
    `    pose: ${pose}`,
    `    background: ${background}`,
    `    text: ${JSON.stringify(text)}`,
    `    duration: ${duration}`,
    "",
  ].join("\n");

  await page
    .locator(".project-toolbar input[type=file]")
    .setInputFiles({
      name: "render-fixture.yaml",
      mimeType: "text/yaml",
      buffer: Buffer.from(source),
    });

  await expect
    .poll(async () => {
      const lines = await page
        .locator(".preview-frame [data-caption-line]")
        .allTextContents();

      return text.includes(" ")
        ? lines.join(" ").replace(/\s+/gu, " ").trim()
        : lines.join("");
    })
    .toBe(text.replace(/\s+/gu, " ").trim());
};

test("pending visual and YAML drafts block browser render", async ({page}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const renderButton = page.getByRole("button", {name: "Render MP4"});

  await page.getByLabel("Caption").fill("");
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-render-blocked",
    "true",
  );
  await expect(renderButton).toBeDisabled();

  await page.getByRole("button", {name: "Open YAML"}).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", {name: "Discard visual draft"}).click();

  const yaml = page.getByLabel("YAML source");
  await yaml.fill((await yaml.inputValue()).replace(
    "Tora tiene una regla.",
    "Unapplied YAML render draft",
  ));

  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-render-blocked",
    "true",
  );
  await expect(renderButton).toBeDisabled();
});

test("shared caption layout exposes centered, left, natural wrap, and hard wrap fixtures", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  await importSingleScene(page, {
    type: "intro",
    text: "Centered caption fixture",
  });
  let caption = page.locator("[data-caption-align=center]").first();
  await expect(caption).toBeVisible();
  await expect
    .poll(async () =>
      caption
        .locator("[data-caption-line]")
        .allTextContents()
        .then((lines) => lines.join(" ")),
    )
    .toBe("Centered caption fixture");

  const measureContentWidth = () =>
    caption.locator("[data-caption-content]").evaluate((element) => {
      const style = getComputedStyle(element);

      return (
        element.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight)
      );
    });
  const borderBoxWidth = await measureContentWidth();
  expect(borderBoxWidth).toBeCloseTo(864, 0);

  await page.addStyleTag({
    content:
      ".preview-frame [data-caption-align], .preview-frame [data-caption-align] * { box-sizing: content-box !important; }",
  });
  const contentBoxWidth = await measureContentWidth();
  expect(contentBoxWidth).toBeCloseTo(borderBoxWidth, 0);

  await importSingleScene(page, {
    type: "dialogue",
    text: "Left aligned caption fixture",
    pose: "confused",
  });
  caption = page.locator("[data-caption-align=left]").first();
  await expect(caption).toBeVisible();

  const natural =
    "A long natural language caption keeps wrapping explicit and deterministic across the encoded browser renderer without relying on CSS word breaking.";
  await importSingleScene(page, {
    type: "intro",
    text: natural,
  });
  caption = page.locator("[data-caption-align=center]").first();
  const naturalLines = caption.locator("[data-caption-line]");
  expect(await naturalLines.count()).toBeGreaterThan(1);

  const naturalLineGeometry = await naturalLines.evaluateAll((lines) =>
    lines.map((line) => {
      if (!(line instanceof HTMLElement)) {
        throw new Error("Expected caption line element");
      }

      const frame = line.closest("[data-caption-frame]");

      if (!(frame instanceof HTMLElement)) {
        throw new Error("Missing caption frame");
      }

      const style = getComputedStyle(line);
      const lineHeight = Number.parseFloat(style.lineHeight);
      const frameScale =
        frame.getBoundingClientRect().width / frame.offsetWidth;

      return {
        compositionHeight:
          line.getBoundingClientRect().height / frameScale,
        lineHeight,
      };
    }),
  );

  expect(
    naturalLineGeometry.every(
      ({compositionHeight, lineHeight}) =>
        Math.abs(compositionHeight - lineHeight) <= 1,
    ),
  ).toBe(true);

  const token = "W".repeat(180);
  await importSingleScene(page, {
    type: "chaos",
    text: token,
    pose: "panic",
    background: "server-room",
  });
  caption = page.locator("[data-caption-align=center]").first();
  const hardLines = caption.locator("[data-caption-line]");
  expect(await hardLines.count()).toBeGreaterThan(1);

  const hardText = await hardLines.allTextContents();
  expect(hardText.join("")).toBe(token);

  const wideToken = "OQ".repeat(90);
  await importSingleScene(page, {
    type: "chaos",
    text: wideToken,
    pose: "panic",
    background: "server-room",
  });
  caption = page.locator("[data-caption-align=center]").first();

  const clipping = await caption.evaluate((element) => {
    const content = element.querySelector("[data-caption-content]");
    const lines = [...element.querySelectorAll("[data-caption-line]")];

    if (!(content instanceof HTMLElement)) {
      throw new Error("Missing caption content element");
    }

    const style = getComputedStyle(content);
    const available =
      content.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);

    return lines.map((line) => ({
      text: line.textContent ?? "",
      width:
        line instanceof HTMLElement
          ? line.scrollWidth
          : Number.POSITIVE_INFINITY,
      available,
    }));
  });

  expect(clipping.length).toBeGreaterThan(1);
  expect(
    clipping.every(({width, available}) => width <= available + 1),
  ).toBe(true);

  const numericToken = "0".repeat(15);
  await importSingleScene(page, {
    type: "chaos",
    text: numericToken,
    pose: "panic",
    background: "server-room",
  });
  caption = page.locator("[data-caption-align=center]").first();

  const numericClipping = await caption.evaluate((element) => {
    const content = element.querySelector("[data-caption-content]");
    const lines = [...element.querySelectorAll("[data-caption-line]")];

    if (!(content instanceof HTMLElement)) {
      throw new Error("Missing caption content element");
    }

    const style = getComputedStyle(content);
    const available =
      content.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);

    return lines.map((line) => ({
      width:
        line instanceof HTMLElement
          ? line.scrollWidth
          : Number.POSITIVE_INFINITY,
      available,
    }));
  });

  expect(numericClipping.length).toBeGreaterThan(1);
  expect(
    numericClipping.every(
      ({width, available}) => width <= available + 1,
    ),
  ).toBe(true);

  const decomposed = "e\u0301".repeat(90);
  await importSingleScene(page, {
    type: "chaos",
    text: decomposed,
    pose: "panic",
    background: "server-room",
  });
  const decomposedLines = await page
    .locator("[data-caption-align=center] [data-caption-line]")
    .allTextContents();

  expect(decomposedLines.join("")).toBe(decomposed);
  expect(
    decomposedLines.every((line) => !/^\p{Mark}/u.test(line)),
  ).toBe(true);
});

test("encoded browser render preserves long natural and hard-wrap caption geometry", async ({
  page,
}) => {
  test.setTimeout(240_000);

  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  if (!(await waitForBrowserRenderAvailability(page))) {
    test.skip(true, "Browser web rendering is unavailable in this runtime");
  }

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

test("browser render capability either explains fallback or renders canonical H.264 MP4", async ({
  page,
}) => {
  test.setTimeout(240_000);

  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const banner = page.locator(".render-banner");
  const renderButton = page.getByRole("button", {name: "Render MP4"});

  await expect
    .poll(async () => {
      const text = (await banner.textContent()) ?? "";
      const disabled = await renderButton.isDisabled();

      return (
        !text.includes("Checking browser render support") &&
        (!disabled || /unavailable|requires|instead|local CLI/i.test(text))
      );
    }, {timeout: 15_000})
    .toBe(true);

  if (await renderButton.isDisabled()) {
    await expect(banner).toContainText(/YAML|CLI|browser/i);
    await expect(page.getByLabel("Caption")).toBeEnabled();
    return;
  }

  const downloadPromise = page.waitForEvent("download", {timeout: 220_000});
  await renderButton.click();

  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-authoring-locked",
    "true",
  );
  await expect(page.getByLabel("Caption")).toBeDisabled();
  await expect(
    page.getByRole("button", {name: "Cancel Render"}),
  ).toBeVisible();

  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("Deploy-Friday.mp4");

  const path = await download.path();
  expect(path).not.toBeNull();

  if (path === null) {
    throw new Error("Expected browser MP4 download path");
  }

  const bytes = await readFile(path);
  expect(bytes.byteLength).toBeGreaterThan(0);

  const {stdout} = await execFileAsync(
    "npx",
    [
      "remotion",
      "ffprobe",
      "-v",
      "error",
      "-count_frames",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      path,
    ],
    {timeout: 60_000},
  );
  const metadata = JSON.parse(stdout);
  const videoStreams = metadata.streams.filter(
    (stream) => stream.codec_type === "video",
  );
  const audioStreams = metadata.streams.filter(
    (stream) => stream.codec_type === "audio",
  );

  expect(videoStreams).toHaveLength(1);
  expect(audioStreams).toHaveLength(0);
  expect(videoStreams[0].codec_name).toBe("h264");
  expect(videoStreams[0].width).toBe(1080);
  expect(videoStreams[0].height).toBe(1920);
  const frameCount = Number(
    videoStreams[0].nb_read_frames ?? videoStreams[0].nb_frames,
  );
  const duration = Number(metadata.format.duration);

  expect(frameCount).toBe(360);
  expect(duration).toBeCloseTo(12, 2);
  expect(frameCount / duration).toBeCloseTo(30, 1);

  const [introFrame, dialogueFrame, chaosFrame, punchlineFrame] =
    await Promise.all([
      decodeMp4Frame(path, 1.5),
      decodeMp4Frame(path, 4.5),
      decodeMp4Frame(path, 7.5),
      decodeMp4Frame(path, 10.5),
    ]);

  for (const frame of [
    introFrame,
    dialogueFrame,
    chaosFrame,
    punchlineFrame,
  ]) {
    const fullFrame = regionStats(frame, {
      x: 0,
      y: 0,
      width: DECODED_FRAME_WIDTH,
      height: DECODED_FRAME_HEIGHT,
    });

    expect(fullFrame.standardDeviation).toBeGreaterThan(15);
    expect(fullFrame.brightRatio).toBeGreaterThan(0.001);
  }

  const topCaptionRegion = {
    x: 36,
    y: 48,
    width: 468,
    height: 92,
  };
  const bottomCaptionRegion = {
    x: 36,
    y: 830,
    width: 468,
    height: 82,
  };

  for (const [frame, region, edgeY] of [
    [introFrame, topCaptionRegion, 68],
    [dialogueFrame, bottomCaptionRegion, 860],
    [chaosFrame, topCaptionRegion, 68],
    [punchlineFrame, bottomCaptionRegion, 860],
  ]) {
    const captionStats = regionStats(frame, region, 2);

    expect(captionStats.darkRatio).toBeGreaterThan(0.08);
    expect(captionStats.brightRatio).toBeGreaterThan(0.0005);
    expect(
      captionHorizontalEdgeContrast(frame, edgeY),
    ).toBeGreaterThan(5);
  }

  const toraRegion = {
    x: 36,
    y: 390,
    width: 430,
    height: 390,
  };
  expect(
    meanAbsoluteFrameDifference(
      introFrame,
      dialogueFrame,
      toraRegion,
    ),
  ).toBeGreaterThan(10);
  expect(
    meanAbsoluteFrameDifference(
      introFrame,
      punchlineFrame,
      toraRegion,
    ),
  ).toBeGreaterThan(10);

  expect(
    meanAbsoluteFrameDifference(
      dialogueFrame,
      chaosFrame,
      {
        x: 0,
        y: 0,
        width: DECODED_FRAME_WIDTH,
        height: DECODED_FRAME_HEIGHT,
      },
      6,
    ),
  ).toBeGreaterThan(10);

  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-render-state",
    "success",
  );
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-authoring-locked",
    "false",
  );
});


test("Cancel Render aborts a supported browser render and unlocks authoring", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const banner = page.locator(".render-banner");
  const renderButton = page.getByRole("button", {name: "Render MP4"});

  await expect
    .poll(async () => {
      const text = (await banner.textContent()) ?? "";
      const disabled = await renderButton.isDisabled();

      return (
        !text.includes("Checking browser render support") &&
        (!disabled || /unavailable|requires|instead|local CLI/i.test(text))
      );
    }, {timeout: 15_000})
    .toBe(true);

  if (await renderButton.isDisabled()) {
    return;
  }

  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });

  await renderButton.click();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-authoring-locked",
    "true",
  );

  await page.getByRole("button", {name: "Cancel Render"}).click();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-render-state",
    "cancelling",
  );

  await expect
    .poll(() =>
      page.locator(".app-shell").getAttribute("data-render-state"),
      {timeout: 90_000},
    )
    .not.toMatch(/^(?:rendering|cancelling)$/);

  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-authoring-locked",
    "false",
  );
  expect(downloaded).toBe(false);
});
