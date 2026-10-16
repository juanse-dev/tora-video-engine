import {createHash} from "node:crypto";
import {expect, test} from "@playwright/test";
import {fixtureBytes} from "../helpers/audioBytes.mjs";
import {localAssetRef} from "./helpers/seedAssetLibrary.mjs";
import {waitForOwner} from "./helpers/localAssetPage.mjs";

const section = (page) => page.locator("[data-my-audio]");
const refOf = (bytes) => localAssetRef("audio", createHash("sha256").update(bytes).digest("hex"));

// Bundled Chromium cannot decode AAC; system Chrome can, so M4A is verified here.
test("an M4A (AAC-LC) file imports with its duration and survives a reload", async ({page}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  for (const [name, label, duration] of [
    ["tone-440-2.2s.m4a", "tone-440-2.2s", "0:02"],
    ["tone-220-10s.m4a", "tone-220-10s", "0:10"],
  ]) {
    const bytes = fixtureBytes(name);

    await section(page)
      .locator('.my-assets-toolbar input[type="file"]')
      .setInputFiles({name, mimeType: "audio/mp4", buffer: Buffer.from(bytes)});
    await expect(section(page).locator('[role="status"]:not([data-audio-preview-error])')).toHaveText(`Imported "${label}".`);
    await expect(
      page.locator(`[data-local-asset-card="${refOf(bytes)}"] [data-audio-duration]`),
    ).toHaveText(duration);
  }

  await page.reload({waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await expect(section(page).getByRole("heading", {name: "My audio · 2"})).toBeVisible();
});
