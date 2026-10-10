import {execFile} from "node:child_process";
import {readFile} from "node:fs/promises";
import {promisify} from "node:util";
import {expect, test} from "@playwright/test";
import {
  applyYaml,
  BACKGROUND_BOTTOM_REGION,
  BACKGROUND_TOP_REGION,
  decodeMp4Frame,
  FULL_REGION,
  isCyan,
  isMagenta,
  isYellow,
  meanLuminance,
  openSeeded,
  POSE_MAGENTA_REGION,
  regionRatio,
} from "./helpers/localAssetPage.mjs";
import {
  fixtureRecord,
  localAssetRef,
  readFixture,
} from "./helpers/seedAssetLibrary.mjs";

const execFileAsync = promisify(execFile);

const FRAME_WIDTH = 540;
const FRAME_HEIGHT = 960;
const RGB_CHANNELS = 3;

const analyzeCanonicalEncodedFrames = async (page, path) => {
  const encodedMp4 = (await readFile(path)).toString("base64");

  return page.evaluate(
    async ({encodedMp4: base64, frameWidth, frameHeight}) => {
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

      const canvas = document.createElement("canvas");
      canvas.width = frameWidth;
      canvas.height = frameHeight;
      const context = canvas.getContext("2d", {
        willReadFrequently: true,
      });

      if (context === null) {
        throw new Error("Could not create canonical frame canvas");
      }

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
            const index = (py * frameWidth + px) * 4;
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
            const index = (py * frameWidth + px) * 4;

            difference +=
              (Math.abs(first[index] - second[index]) +
                Math.abs(first[index + 1] - second[index + 1]) +
                Math.abs(first[index + 2] - second[index + 2])) /
              3;
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

      const capture = async (seconds) => {
        if (Math.abs(video.currentTime - seconds) > 0.001) {
          const seeked = waitFor(
            "seeked",
            "Could not seek canonical browser MP4",
          );
          video.currentTime = seconds;
          await seeked;
        }

        context.clearRect(0, 0, frameWidth, frameHeight);
        context.drawImage(
          video,
          0,
          0,
          frameWidth,
          frameHeight,
        );

        return new Uint8ClampedArray(
          context.getImageData(
            0,
            0,
            frameWidth,
            frameHeight,
          ).data,
        );
      };

      document.body.append(video);

      try {
        await waitFor(
          "loadedmetadata",
          "Could not load canonical browser MP4 metadata",
        );

        const frames = [];
        for (const seconds of [1.5, 4.5, 7.5, 10.5]) {
          frames.push(await capture(seconds));
        }

        const [
          introFrame,
          dialogueFrame,
          chaosFrame,
          punchlineFrame,
        ] = frames;
        const fullRegion = {
          x: 0,
          y: 0,
          width: frameWidth,
          height: frameHeight,
        };
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
        const captionFrames = [
          [introFrame, topCaptionRegion, 68],
          [dialogueFrame, bottomCaptionRegion, 860],
          [chaosFrame, topCaptionRegion, 68],
          [punchlineFrame, bottomCaptionRegion, 860],
        ];
        const toraRegion = {
          x: 36,
          y: 390,
          width: 430,
          height: 390,
        };

        return {
          decodedDuration: video.duration,
          fullFrameStats: frames.map((frame) =>
            regionStats(frame, fullRegion),
          ),
          captionStats: captionFrames.map(
            ([frame, region, edgeY]) => ({
              region: regionStats(frame, region, 2),
              edgeContrast:
                captionHorizontalEdgeContrast(frame, edgeY),
            }),
          ),
          introDialogueToraDifference:
            meanAbsoluteFrameDifference(
              introFrame,
              dialogueFrame,
              toraRegion,
            ),
          introPunchlineToraDifference:
            meanAbsoluteFrameDifference(
              introFrame,
              punchlineFrame,
              toraRegion,
            ),
          dialogueChaosFrameDifference:
            meanAbsoluteFrameDifference(
              dialogueFrame,
              chaosFrame,
              fullRegion,
              6,
            ),
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
    },
  );
};

const luminanceStandardDeviation = (frame) => {
  let count = 0;
  let sum = 0;
  let sumSquares = 0;

  for (let index = 0; index < frame.length; index += RGB_CHANNELS * 4) {
    const luminance =
      frame[index] * 0.2126 +
      frame[index + 1] * 0.7152 +
      frame[index + 2] * 0.0722;

    count += 1;
    sum += luminance;
    sumSquares += luminance * luminance;
  }

  const mean = sum / count;

  return Math.sqrt(Math.max(0, sumSquares / count - mean * mean));
};

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
    // The web renderer paints text through Canvas rather than the DOM
    // glyph rasterizer. Keep width parity semantic while clipping/alignment
    // remain strict against the encoded caption frame.
    expect(encodedWidth).toBeLessThan(
      expectedWidth * 1.3 + 8,
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

const assertMp4Metadata = async (
  path,
  {expectedFrames = 30, expectedDuration = 1} = {},
) => {
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

  expect(frameCount).toBe(expectedFrames);
  expect(duration).toBeCloseTo(expectedDuration, 2);
  expect(frameCount / duration).toBeCloseTo(30, 1);
};

test("required Chrome runtime renders the canonical 12-second Story golden", async ({
  page,
}) => {
  test.setTimeout(240_000);

  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await requireBrowserRender(page);

  const downloadPromise = page.waitForEvent("download", {
    timeout: 220_000,
  });
  await page.getByRole("button", {name: "Render MP4"}).click();

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

  if (path === null) {
    throw new Error("Expected canonical browser MP4 download path");
  }

  const bytes = await readFile(path);
  expect(bytes.byteLength).toBeGreaterThan(0);

  await assertMp4Metadata(path, {
    expectedFrames: 360,
    expectedDuration: 12,
  });

  const analysis =
    await analyzeCanonicalEncodedFrames(page, path);

  expect(analysis.decodedDuration).toBeCloseTo(12, 2);

  for (const fullFrame of analysis.fullFrameStats) {
    expect(fullFrame.standardDeviation).toBeGreaterThan(15);
    expect(fullFrame.brightRatio).toBeGreaterThan(0.001);
  }

  for (const {region, edgeContrast} of analysis.captionStats) {
    expect(region.darkRatio).toBeGreaterThan(0.08);
    expect(region.brightRatio).toBeGreaterThan(0.0005);
    expect(edgeContrast).toBeGreaterThan(5);
  }

  expect(
    analysis.introDialogueToraDifference,
  ).toBeGreaterThan(10);
  expect(
    analysis.introPunchlineToraDifference,
  ).toBeGreaterThan(10);
  expect(
    analysis.dialogueChaosFrameDifference,
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

test("required Chrome runtime renders seeded local assets into the MP4 golden", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const pose = await readFixture("pose-magenta.png");
  const background = await readFixture("background-cyan.jpg");
  const story = [
    'title: "Local assets golden"',
    "scenes:",
    // Scene 1 (0-1 s): seeded local pose + background.
    "  - type: intro",
    `    pose: ${localAssetRef("pose", pose.digest)}`,
    `    background: ${localAssetRef("background", background.digest)}`,
    '    text: "Local assets"',
    "    duration: 1",
    // Scene 2 (1-2 s): bundled only, the positive control for the decode.
    "  - type: intro",
    "    pose: formal",
    "    background: office",
    '    text: "Bundled control"',
    "    duration: 1",
    "",
  ].join("\n");

  await openSeeded(page, [
    fixtureRecord("pose", pose),
    fixtureRecord("background", background),
  ]);
  await requireBrowserRender(page);
  await applyYaml(page, story);
  await expect(page.locator("#preview-heading")).toHaveText(
    "Local assets golden",
  );
  await expect(
    page.locator(".preview-frame img[src^='blob:']"),
  ).toHaveCount(2);

  const path = await downloadRenderedMp4(page);

  await assertMp4Metadata(path, {
    expectedFrames: 60,
    expectedDuration: 2,
  });

  const localFrame = await decodeMp4Frame(path, 0.5);
  const bundledFrame = await decodeMp4Frame(path, 1.5);

  // Positive control: both frames decoded to real, non-black pictures, and the
  // bundled-only scene shows no local magenta.
  for (const frame of [localFrame, bundledFrame]) {
    expect(meanLuminance(frame)).toBeGreaterThan(20);
    expect(luminanceStandardDeviation(frame)).toBeGreaterThan(15);
  }

  expect(
    regionRatio(bundledFrame, FULL_REGION, isMagenta),
  ).toBeLessThan(0.001);

  // Local pose: the magenta rectangle is drawn in the pose area.
  expect(
    regionRatio(localFrame, POSE_MAGENTA_REGION, isMagenta),
  ).toBeGreaterThan(0.9);

  // Local background: cyan in the top half, yellow in the bottom half, and not
  // the other way round.
  expect(
    regionRatio(localFrame, BACKGROUND_TOP_REGION, isCyan),
  ).toBeGreaterThan(0.9);
  expect(
    regionRatio(localFrame, BACKGROUND_BOTTOM_REGION, isYellow),
  ).toBeGreaterThan(0.9);
  expect(
    regionRatio(localFrame, BACKGROUND_TOP_REGION, isYellow),
  ).toBeLessThan(0.02);
  expect(
    regionRatio(localFrame, BACKGROUND_BOTTOM_REGION, isCyan),
  ).toBeLessThan(0.02);
});
