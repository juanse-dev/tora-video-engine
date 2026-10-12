// Focus restore after a My assets dialog closes (ASSET-003 R16, #48).
//
// Runs in Chromium, Firefox and WebKit (see playwright.config.mjs): browsers
// differ in whether a click focuses a button, so every dialog here is opened
// from the keyboard, which focuses the control the same way everywhere.
//
// The contract (AssetDialogHost): opening a dialog moves focus to Cancel;
// closing it, by Cancel, Escape or a confirm, returns focus to the control
// that opened it. When that control no longer exists (the deleted asset's
// card, the replaced missing card) there is nothing to restore and focus falls
// to <body>.
import {expect, test} from "@playwright/test";
import {
  buildStoryYaml,
  fixtureRecord,
  localAssetRef,
  readFixture,
} from "./helpers/seedAssetLibrary.mjs";
import {applyYaml, openSeeded} from "./helpers/localAssetPage.mjs";

const cardFor = (page, digest) =>
  page.locator(`[data-local-asset-card="${localAssetRef("pose", digest)}"]`);

const closers = {
  cancel: async (page, dialog) => {
    await dialog.getByRole("button", {name: "Cancel"}).click();
  },
  escape: async (page) => {
    await page.keyboard.press("Escape");
  },
};

const fileUpload = (fixture) => ({
  name: fixture.name,
  mimeType: fixture.meta.mimeType,
  buffer: Buffer.from(fixture.bytes),
});

/** Opens the delete dialog for the seeded pose from the keyboard. */
const openDeleteDialog = async (page) => {
  const pose = await readFixture("pose-magenta.png");

  await openSeeded(page, [fixtureRecord("pose", pose, {label: "My cat"})]);

  const deleteButton = cardFor(page, pose.digest).getByRole("button", {
    name: "Delete My cat",
    exact: true,
  });
  const dialog = page.getByRole("dialog");

  await deleteButton.focus();
  await expect(deleteButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", {name: "Cancel"})).toBeFocused();

  return {pose, deleteButton, dialog};
};

for (const closer of ["cancel", "escape"]) {
  test(`the delete dialog returns focus to its Delete button on ${closer}`, async ({
    page,
  }) => {
    const {pose, deleteButton, dialog} = await openDeleteDialog(page);

    await closers[closer](page, dialog);
    await expect(dialog).toHaveCount(0);
    await expect(cardFor(page, pose.digest)).toBeVisible();
    await expect(deleteButton).toBeFocused();
  });
}

test("the delete dialog leaves focus on the page body after Delete asset removed the card", async ({
  page,
}) => {
  const {pose, dialog} = await openDeleteDialog(page);

  await dialog.getByRole("button", {name: "Delete asset", exact: true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(cardFor(page, pose.digest)).toHaveCount(0);
  // The opener is gone, so there is nothing to restore; focus is not left
  // inside the removed dialog either.
  await expect(page.locator("body")).toBeFocused();
});

/** Opens the mismatch dialog from the missing card's keyboard-focused file input. */
const openMismatchDialog = async (page) => {
  const pose = await readFixture("pose-magenta.png");
  const other = await readFixture("background-cyan.jpg");
  const ref = localAssetRef("pose", pose.digest);

  await openSeeded(page, []);
  await applyYaml(
    page,
    buildStoryYaml([{pose: ref, background: "office"}]),
  );
  await page.getByRole("button", {name: "Open visual editor"}).click();

  const input = page
    .locator(`[data-missing-local-asset-card="${ref}"]`)
    .locator('input[type="file"]');
  const dialog = page.getByRole("dialog");

  await input.focus();
  await expect(input).toBeFocused();
  await input.setInputFiles(fileUpload(other));
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", {name: "Cancel"})).toBeFocused();

  return {input, dialog, other};
};

for (const closer of ["cancel", "escape"]) {
  test(`the mismatch dialog returns focus to the Import matching file input on ${closer}`, async ({
    page,
  }) => {
    const {input, dialog} = await openMismatchDialog(page);

    await closers[closer](page, dialog);
    await expect(dialog).toHaveCount(0);
    await expect(input).toBeFocused();
  });
}

test("the mismatch dialog leaves focus on the page body after Use it as replacement removed the missing card", async ({
  page,
}) => {
  const {input, dialog} = await openMismatchDialog(page);

  await dialog
    .getByRole("button", {name: "Use it as replacement for this scene"})
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(input).toHaveCount(0);
  await expect(page.locator("body")).toBeFocused();
});
