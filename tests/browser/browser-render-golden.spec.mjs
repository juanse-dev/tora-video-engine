import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {expect, test} from "@playwright/test";

const execFileAsync = promisify(execFile);

const FRAME_WIDTH = 540;
const FRAME_HEIGHT = 960;
const RGB_CHANNELS = 3;

const waitForOwner = async (page) => {
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-persistence-mode",
    "owner",
    {timeout: 10_000},
  );
};

const requireBrowserRender = async (page) => {
  const renderButton = page.getByRole("button", {name: "Render MP4"});
  const banner = page.locator(".render-banner");

  await expect
    .poll(
      async () => (await banner.textContent()) ?? "",
      {timeout: 20_000},
    )
    .not.toContain("Checking browser render support");

  await expect(renderButton).toBeEnabled({timeout: 20_000});
  await expect(banner).toContainText(
    "Browser MP4 rendering is ready.",
  );
};

const importSingleScene = async (
  page,
  {
    title,
    type,
    text,
    pose,
    background,
  },
) => {
  const source = [
    `title: ${JSON.stringify(title)}`,
    "scenes:",
    `  - type: ${type}`,
    `    pose: ${pose}`,
    `    background: ${background}`,
    `    text: ${JSON.stringify(text)}`,
    "    duration: 1",
    "",
  ].join("\n");

  await page
    .locator(".project-toolbar input[type=file]")
    .setInputFiles({
      name: "required-browser-golden.yaml",
      mimeType: "text/yaml",
      buffer: Buffer.from(source),
    });

  await expect(page.locator("#preview-heading")).toHaveText(title);
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

const downloadRenderedMp4 = async (page) => {
  const renderButton = page.getByRole("button", {name: "Render MP4"});
  await expect(renderButton).toBeEnabled({timeout: 20_000});

  const downloadPromise = page.waitForEvent("download", {
    timeout: 120_000,
  });
  await renderButton.click();

  const download = await downloadPromise;
  const path = await download.path();

  expect(path).not.toBeNull();

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

  return caption.evaluate((element) => {
    const frame = element.querySelector("[data-caption-frame]");
    const lines = [
      ...element.querySelectorAll("[data-caption-line]"),
    ];

    if (!(frame instanceof HTMLElement)) {
      throw new Error("Missing caption frame");
    }

    const frameRect = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);

    return {
      align: element.getAttribute("data-caption-align"),
      fontFamily: style.fontFamily,
      fontSize:
        Number.parseFloat(style.fontSize) *
        (936 / frameRect.width),
      frameHeight:
        frameRect.height * (936 / frameRect.width) * 0.5,
      lineCount: lines.length,
      lineWidthRatios: lines.map((line) => {
        const rect = line.getBoundingClientRect();
        return rect.width / frameRect.width;
      }),
    };
  });
};

const decodeFrame = async (path) => {
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
      "0.5",
      "-frames:v",
      "1",
      "-vf",
      `scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:flags=bilinear`,
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    {
      encoding: null,
      maxBuffer:
        FRAME_WIDTH * FRAME_HEIGHT * RGB_CHANNELS +
        1024 * 1024,
      timeout: 60_000,
    },
  );

  const frame = Buffer.isBuffer(stdout)
    ? stdout
    : Buffer.from(stdout);

  expect(frame.byteLength).toBe(
    FRAME_WIDTH * FRAME_HEIGHT * RGB_CHANNELS,
  );

  return frame;
};

const luminanceAt = (frame, x, y) => {
  const index = (y * FRAME_WIDTH + x) * RGB_CHANNELS;

  return (
    frame[index] * 0.2126 +
    frame[index + 1] * 0.7152 +
    frame[index + 2] * 0.0722
  );
};

const findTextBands = (
  frame,
  {x, y, width, height},
) => {
  const activeRows = [];

  for (let py = y; py < y + height; py += 1) {
    let brightPixels = 0;

    for (let px = x; px < x + width; px += 1) {
      if (luminanceAt(frame, px, py) > 150) {
        brightPixels += 1;
      }
    }

    if (brightPixels >= 3) {
      activeRows.push(py);
    }
  }

  const bands = [];

  for (const row of activeRows) {
    const current = bands.at(-1);

    if (current && row - current.end <= 3) {
      current.end = row;
    } else {
      bands.push({start: row, end: row});
    }
  }

  return bands;
};

const getBandBounds = (
  frame,
  band,
  {x, width},
) => {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;

  for (let py = band.start; py <= band.end; py += 1) {
    for (let px = x; px < x + width; px += 1) {
      if (luminanceAt(frame, px, py) > 150) {
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
      }
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    throw new Error("Expected encoded caption pixels");
  }

  return {minX, maxX};
};

const assertEncodedCaption = ({
  frame,
  expectation,
  placement,
}) => {
  expect(expectation.fontFamily).toMatch(/Inter/i);
  expect(expectation.lineCount).toBeGreaterThan(1);

  const captionX = 36;
  const captionWidth = 468;
  const captionY =
    placement === "top"
      ? 48
      : Math.round(
          FRAME_HEIGHT - 48 - expectation.frameHeight,
        );
  const scan = {
    x: captionX + 8,
    y: captionY + 4,
    width: captionWidth - 16,
    height: Math.max(
      1,
      Math.round(expectation.frameHeight) - 8,
    ),
  };
  const bands = findTextBands(frame, scan);

  expect(bands).toHaveLength(expectation.lineCount);

  const bounds = bands.map((band) =>
    getBandBounds(frame, band, {
      x: scan.x,
      width: scan.width,
    }),
  );

  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const bound = bounds[index];
    const bandHeight = band.end - band.start + 1;
    const encodedWidth = bound.maxX - bound.minX + 1;
    const expectedWidth =
      expectation.lineWidthRatios[index] * captionWidth;

    expect(bandHeight).toBeGreaterThan(
      Math.max(8, expectation.fontSize * 0.16),
    );
    expect(bandHeight).toBeLessThan(
      expectation.fontSize * 0.65,
    );
    expect(bound.minX).toBeGreaterThan(captionX + 4);
    expect(bound.maxX).toBeLessThan(
      captionX + captionWidth - 4,
    );
    expect(encodedWidth).toBeGreaterThan(
      expectedWidth * 0.55,
    );
    expect(encodedWidth).toBeLessThan(
      expectedWidth * 1.1 + 8,
    );
  }

  if (expectation.align === "center") {
    for (const {minX, maxX} of bounds) {
      expect(
        Math.abs((minX + maxX) / 2 - FRAME_WIDTH / 2),
      ).toBeLessThan(22);
    }
  } else {
    const leftEdges = bounds.map(({minX}) => minX);
    expect(Math.min(...leftEdges)).toBeLessThan(70);
    expect(
      Math.max(...leftEdges) - Math.min(...leftEdges),
    ).toBeLessThan(6);
  }
};

const assertMp4Metadata = async (path) => {
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
  const video = metadata.streams.filter(
    (stream) => stream.codec_type === "video",
  );
  const audio = metadata.streams.filter(
    (stream) => stream.codec_type === "audio",
  );

  expect(video).toHaveLength(1);
  expect(audio).toHaveLength(0);
  expect(video[0].codec_name).toBe("h264");
  expect(video[0].width).toBe(1080);
  expect(video[0].height).toBe(1920);
  const frameCount = Number(
    video[0].nb_read_frames ?? video[0].nb_frames,
  );
  const duration = Number(metadata.format.duration);

  expect(frameCount).toBe(30);
  expect(duration).toBeCloseTo(1, 2);
  expect(frameCount / duration).toBeCloseTo(30, 1);
};

test("required Chrome runtime renders encoded long-wrap MP4 goldens", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await requireBrowserRender(page);

  const fixtures = [
    {
      name: "natural",
      title: "Natural browser golden",
      type: "intro",
      pose: "formal",
      background: "office",
      placement: "top",
      align: "center",
      text:
        "A long natural language caption keeps wrapping explicit and deterministic across the encoded browser renderer without relying on CSS word breaking.",
    },
    {
      name: "hard-wrap",
      title: "Hard wrap browser golden",
      type: "dialogue",
      pose: "confused",
      background: "office",
      placement: "bottom",
      align: "left",
      text: "W".repeat(120),
    },
  ];

  for (const fixture of fixtures) {
    await importSingleScene(page, fixture);
    const expectation = await getCaptionExpectation(page);

    expect(expectation.align).toBe(fixture.align);

    const path = await downloadRenderedMp4(page);

    await assertMp4Metadata(path);
    const frame = await decodeFrame(path);

    assertEncodedCaption({
      frame,
      expectation,
      placement: fixture.placement,
    });
  }
});
