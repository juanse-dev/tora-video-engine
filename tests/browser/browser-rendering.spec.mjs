import {execFile} from "node:child_process";
import {readFile} from "node:fs/promises";
import {promisify} from "node:util";
import {expect, test} from "@playwright/test";

const execFileAsync = promisify(execFile);

const waitForOwner = async (page) => {
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-persistence-mode",
    "owner",
    {timeout: 10_000},
  );
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
    "A long natural language caption keeps wrapping explicit and deterministic across the shared renderer without CSS word breaking.";
  await importSingleScene(page, {
    type: "dialogue",
    text: natural,
    pose: "confused",
  });
  caption = page.locator("[data-caption-align=left]").first();
  const naturalLines = caption.locator("[data-caption-line]");
  expect(await naturalLines.count()).toBeGreaterThan(1);

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
  expect(videoStreams[0].avg_frame_rate).toBe("30/1");
  expect(
    Number(videoStreams[0].nb_read_frames ?? videoStreams[0].nb_frames),
  ).toBe(360);
  expect(Number(metadata.format.duration)).toBeCloseTo(12, 2);

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
