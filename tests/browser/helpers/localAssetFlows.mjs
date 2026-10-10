import {readFile} from "node:fs/promises";
import {expect} from "@playwright/test";
import {localAssetRef} from "./seedAssetLibrary.mjs";

// Page-level helpers shared by the ASSET-006 portability and cross-tab specs:
// importing through the My assets UI, reading and exporting the Story YAML,
// and locating cards and Player placeholders.

export const section = (page, category) =>
  page.locator(`[data-my-assets="${category}"]`);
export const cards = (page, category) =>
  section(page, category).locator("[data-local-asset-card]");
export const cardFor = (page, category, digest) =>
  page.locator(`[data-local-asset-card="${localAssetRef(category, digest)}"]`);
export const missingCard = (page, ref) =>
  page.locator(`[data-missing-local-asset-card="${ref}"]`);
export const importInput = (page, category) =>
  section(page, category).locator('input[type="file"]');
export const statusLine = (page, category) =>
  section(page, category).getByRole("status");

export const previewPlaceholders = (page) =>
  page.locator(".preview-frame [data-missing-local-asset]");
export const blobImages = (page) =>
  page.locator(".preview-frame img[src^='blob:']");
export const renderBanner = (page) => page.locator(".render-banner");

export const fixtureUpload = (fixture) => ({
  name: fixture.name,
  mimeType: fixture.meta.mimeType,
  buffer: Buffer.from(fixture.bytes),
});

/** The YAML editor's text; leaves the app in the visual editor. */
export const yamlSource = async (page) => {
  await page.getByRole("button", {name: "Open YAML"}).click();

  const source = await page.getByLabel("YAML source").inputValue();

  await page.getByRole("button", {name: "Open visual editor"}).click();

  return source;
};

/** Clicks "Export active Story YAML" and returns the downloaded text and name. */
export const exportActiveYaml = async (page) => {
  const downloadPromise = page.waitForEvent("download");

  await page
    .getByRole("button", {name: "Export active Story YAML"})
    .first()
    .click();

  const download = await downloadPromise;
  const path = await download.path();

  expect(path).not.toBeNull();

  return {
    filename: download.suggestedFilename(),
    text: await readFile(path, "utf8"),
  };
};

/** Imports a YAML file through the toolbar, confirming the discard prompt if shown. */
export const importYamlFile = async (page, name, source) => {
  await page.locator(".project-toolbar input[type=file]").setInputFiles({
    name,
    mimeType: "text/yaml",
    buffer: Buffer.from(source),
  });

  const confirmImport = page.getByRole("button", {
    name: "Discard current work and import",
  });

  if (await confirmImport.isVisible()) {
    await confirmImport.click();
  }
};

/** Every local asset ref in `text`, in order of appearance. */
export const localRefsIn = (text) =>
  text.match(/local:[a-z]+:sha256:[0-9a-f]{64}/gu) ?? [];
