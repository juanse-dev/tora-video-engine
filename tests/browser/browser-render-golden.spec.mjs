import {execFile} from "node:child_process";
import {readFile} from "node:fs/promises";
import {promisify} from "node:util";
import {expect, test} from "@playwright/test";

const execFileAsync = promisify(execFile);

const FRAME_WIDTH = 540;
const FRAME_HEIGHT = 960;

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
      lineBoxes: lines.map((line) => {
        const rect = line.getBoundingClientRect();

        return {
          topRatio:
            (rect.top - frameRect.top) / frameRect.height,
          heightRatio: rect.height / frameRect.height,
          widthRatio: rect.width / frameRect.width,
        };
      }),
    };
  });
};

const analyzeEncodedCaptionFrame = async (
  page,
  path,
  lineRegions,
) => {
  const encodedMp4 = (await readFile(path)).toString("base64");

  return page.evaluate(
    async ({
      encodedMp4: base64,
      frameWidth,
      frameHeight,
      lineRegions: regions,
    }) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);

      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }

      const blob = new Blob([bytes], {type: "video/mp4"});
      const url = URL.createObjectURL(blob);
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.src = url;

      const waitFor = (eventName, errorMessage) =>
        new Promise((resolve, reject) => {
          const cleanup = () => {
            video.removeEventListener(eventName, onSuccess);
            video.removeEventListener("error", onError);
          };
          const onSuccess = () => {
            cleanup();
            resolve();
          };
          const onError = () => {
            cleanup();
            reject(
              new Error(
                `${errorMessage}: ${video.error?.message ?? "unknown video error"}`,
              ),
            );
          };

          video.addEventListener(eventName, onSuccess, {once: true});
          video.addEventListener("error", onError, {once: true});
        });

      document.body.append(video);

      try {
        await waitFor(
          "loadedmetadata",
          "Could not load rendered MP4 metadata",
        );

        const seekTime = Math.min(
          0.5,
          Math.max(0, video.duration / 2),
        );

        if (Math.abs(video.currentTime - seekTime) > 0.001) {
          const seeked = waitFor(
            "seeked",
            "Could not seek rendered MP4",
          );
          video.currentTime = seekTime;
          await seeked;
        } else if (
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
        ) {
          await waitFor(
            "loadeddata",
            "Could not decode rendered MP4 frame",
          );
        }

        const canvas = document.createElement("canvas");
        canvas.width = frameWidth;
        canvas.height = frameHeight;
        const context = canvas.getContext("2d", {
          willReadFrequently: true,
        });

        if (context === null) {
          throw new Error("Could not create canvas context");
        }

        context.drawImage(
          video,
          0,
          0,
          frameWidth,
          frameHeight,
        );

        const pixels = context.getImageData(
          0,
          0,
          frameWidth,
          frameHeight,
        ).data;

        const luminanceAt = (x, y) => {
          const index = (y * frameWidth + x) * 4;

          return (
            pixels[index] * 0.2126 +
            pixels[index + 1] * 0.7152 +
            pixels[index + 2] * 0.0722
          );
        };

        const lines = regions.map((region) => {
          let minX = Number.POSITIVE_INFINITY;
          let maxX = Number.NEGATIVE_INFINITY;
          let minY = Number.POSITIVE_INFINITY;
          let maxY = Number.NEGATIVE_INFINITY;
          let brightPixels = 0;

          const startX = Math.max(0, Math.floor(region.x));
          const endX = Math.min(
            frameWidth,
            Math.ceil(region.x + region.width),
          );
          const startY = Math.max(0, Math.floor(region.y));
          const endY = Math.min(
            frameHeight,
            Math.ceil(region.y + region.height),
          );

          for (let py = startY; py < endY; py += 1) {
            for (let px = startX; px < endX; px += 1) {
              // Caption text is #f8fafc over a dark translucent panel. A high
              // threshold isolates encoded glyph pixels from the underlying
              // scene, which may still be moderately bright through the panel.
              if (luminanceAt(px, py) > 210) {
                minX = Math.min(minX, px);
                maxX = Math.max(maxX, px);
                minY = Math.min(minY, py);
                maxY = Math.max(maxY, py);
                brightPixels += 1;
              }
            }
          }

          if (
            !Number.isFinite(minX) ||
            !Number.isFinite(maxX) ||
            !Number.isFinite(minY) ||
            !Number.isFinite(maxY)
          ) {
            throw new Error(
              "Expected encoded caption pixels in every line window",
            );
          }

          return {
            minX,
            maxX,
            minY,
            maxY,
            brightPixels,
          };
        });

        return {
          decodedDuration: video.duration,
          lines,
        };
      } finally {
        video.remove();
        URL.revokeObjectURL(url);
      }
    },
    {
      encodedMp4,
      frameWidth: FRAME_WIDTH,
      frameHeight: FRAME_HEIGHT,
      lineRegions,
    },
  );
};

const assertEncodedCaption = async ({
  page,
  path,
  expectation,
  placement,
}) => {
  expect(expectation.fontFamily).toMatch(/Inter/i);
  expect(expectation.lineCount).toBeGreaterThan(1);
  expect(expectation.lineBoxes).toHaveLength(
    expectation.lineCount,
  );

  const captionX = 36;
  const captionWidth = 468;
  const captionY =
    placement === "top"
      ? 48
      : Math.round(
          FRAME_HEIGHT - 48 - expectation.frameHeight,
        );

  const lineRegions = expectation.lineBoxes.map((line) => ({
    x: captionX + 4,
    y:
      captionY +
      line.topRatio * expectation.frameHeight -
      2,
    width: captionWidth - 8,
    height:
      line.heightRatio * expectation.frameHeight +
      4,
  }));

  const {decodedDuration, lines} =
    await analyzeEncodedCaptionFrame(
      page,
      path,
      lineRegions,
    );

  expect(decodedDuration).toBeCloseTo(1, 2);
  expect(lines).toHaveLength(expectation.lineCount);

  for (let index = 0; index < lines.length; index += 1) {
    const encoded = lines[index];
    const expected = expectation.lineBoxes[index];
    const encodedWidth =
      encoded.maxX - encoded.minX + 1;
    const encodedHeight =
      encoded.maxY - encoded.minY + 1;
    const expectedWidth =
      expected.widthRatio * captionWidth;

    const expectedLineHeight =
      expected.heightRatio * expectation.frameHeight;

    expect(encoded.brightPixels).toBeGreaterThan(20);
    expect(encodedHeight).toBeGreaterThan(
      Math.max(8, expectedLineHeight * 0.45),
    );
    expect(encodedHeight).toBeLessThan(
      expectedLineHeight * 1.35 + 4,
    );
    expect(encoded.minX).toBeGreaterThan(captionX + 4);
    expect(encoded.maxX).toBeLessThan(
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
    for (const [index, {minX, maxX}] of lines.entries()) {
      const actualCenter = (minX + maxX) / 2;
      const expectedBox = expectation.lineBoxes[index];
      const expectedWidth =
        expectedBox.widthRatio * captionWidth;

      expect(
        Math.abs(actualCenter - FRAME_WIDTH / 2),
        JSON.stringify({
          index,
          minX,
          maxX,
          actualCenter,
          expectedCenter: FRAME_WIDTH / 2,
          expectedWidth,
          expectedBox,
          encoded: lines[index],
        }),
      ).toBeLessThan(22);
    }
  } else {
    const leftEdges = lines.map(({minX}) => minX);
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
    await assertEncodedCaption({
      page,
      path,
      expectation,
      placement: fixture.placement,
    });
  }
});
