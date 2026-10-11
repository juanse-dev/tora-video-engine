// Shared by the browser-render specs: imports a one-scene Story through the
// toolbar's YAML file input and waits until the preview shows its caption text.
import {expect} from "@playwright/test";

export const importSingleScene = async (page, {
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

  const collapsibleWhitespace = /[^\S\u00A0\u2007\u202F\uFEFF]+/gu;
  const hasCollapsibleWhitespace =
    /[^\S\u00A0\u2007\u202F\uFEFF]/u.test(text);
  const normalizeCollapsibleWhitespace = (value) =>
    value
      .replace(collapsibleWhitespace, " ")
      .replace(/^[^\S\u00A0\u2007\u202F\uFEFF]+/u, "")
      .replace(/[^\S\u00A0\u2007\u202F\uFEFF]+$/u, "");

  await expect
    .poll(async () => {
      const lines = await page
        .locator(".preview-frame [data-caption-line]")
        .allTextContents();

      return hasCollapsibleWhitespace
        ? normalizeCollapsibleWhitespace(lines.join(" "))
        : lines.join("");
    })
    .toBe(normalizeCollapsibleWhitespace(text));
};
