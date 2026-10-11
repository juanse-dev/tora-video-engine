import {expect, test} from "@playwright/test";
import {importSingleScene} from "./helpers/singleScene.mjs";

const waitForOwner = async (page) => {
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-persistence-mode",
    "owner",
    {timeout: 10_000},
  );
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
    "Tora tiene una regla: Nunca desplegar en viernes.",
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

  const figureSpaceText = `A${"\u2007".repeat(20)}A`;
  await importSingleScene(page, {
    type: "chaos",
    text: figureSpaceText,
    pose: "panic",
    background: "server-room",
  });
  caption = page.locator("[data-caption-align=center]").first();

  const figureSpaceMeasured = await caption.evaluate((element) => {
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

    return {
      available,
      fontSize: Number.parseFloat(getComputedStyle(lines[0]).fontSize),
      lines: lines.map((line) => ({
        text: line.textContent ?? "",
        width:
          line instanceof HTMLElement
            ? line.scrollWidth
            : Number.POSITIVE_INFINITY,
      })),
    };
  });

  expect(figureSpaceMeasured.lines).toHaveLength(1);
  expect(figureSpaceMeasured.lines[0].text).toBe(figureSpaceText);
  expect(figureSpaceMeasured.fontSize).toBeLessThan(92);
  expect(figureSpaceMeasured.lines[0].width).toBeLessThanOrEqual(
    figureSpaceMeasured.available + 1,
  );

  const lowercaseText = "m".repeat(11);
  await importSingleScene(page, {
    type: "chaos",
    text: lowercaseText,
    pose: "panic",
    background: "server-room",
  });
  caption = page.locator("[data-caption-align=center]").first();

  const lowercaseMeasured = await caption.evaluate((element) => {
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

    return {
      available,
      lines: lines.map((line) => ({
        text: line.textContent ?? "",
        width:
          line instanceof HTMLElement
            ? line.scrollWidth
            : Number.POSITIVE_INFINITY,
      })),
    };
  });

  expect(lowercaseMeasured.lines.length).toBeGreaterThan(1);
  expect(
    lowercaseMeasured.lines.map(({text}) => text).join(""),
  ).toBe(lowercaseText);
  expect(
    lowercaseMeasured.lines.every(
      ({width}) => width <= lowercaseMeasured.available + 1,
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

test("browser render capability reports ready or explains fallback", async ({
  page,
}) => {
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

  await expect(banner).toContainText(
    "Browser MP4 rendering is ready.",
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
