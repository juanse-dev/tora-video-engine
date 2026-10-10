import {expect, test} from "@playwright/test";
import {
  applyYaml,
  isBrowserRenderSupported,
  listRemotionOpfsEntries,
  openSeeded,
} from "./helpers/localAssetPage.mjs";
import {
  buildStoryYaml,
  fixtureRecord,
  localAssetRef,
  readFixture,
} from "./helpers/seedAssetLibrary.mjs";

// Needs H.264 browser rendering, which bundled Chromium cannot encode, so this
// file runs under system Chrome (playwright.browser-render.config.mjs) and
// skips itself where rendering is unavailable.

const section = (page, category) =>
  page.locator(`[data-my-assets="${category}"]`);

test("during an MP4 render the My assets import, rename, delete and select controls are disabled", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const pose = await readFixture("pose-magenta.png");
  const background = await readFixture("background-cyan.jpg");
  const poseRef = localAssetRef("pose", pose.digest);

  await openSeeded(page, [
    fixtureRecord("pose", pose, {label: "My cat"}),
    fixtureRecord("background", background, {label: "Sky"}),
  ]);

  if (!(await isBrowserRenderSupported(page))) {
    test.skip(true, "Browser web rendering is unavailable in this runtime");
  }

  await applyYaml(
    page,
    buildStoryYaml([{pose: poseRef, background: "office"}]).replace(
      "duration: 3",
      "duration: 5",
    ),
  );
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await expect(page.locator(".preview-frame img[src^='blob:']")).toHaveCount(1);

  const poseSection = section(page, "pose");
  const backgroundSection = section(page, "background");
  const poseCard = poseSection.locator("[data-local-asset-card]");
  const backgroundCard = backgroundSection.locator("[data-local-asset-card]");
  const controls = [
    poseSection.locator('input[type="file"]'),
    backgroundSection.locator('input[type="file"]'),
    poseCard.getByRole("button", {name: "Rename My cat", exact: true}),
    poseCard.getByRole("button", {name: "Delete My cat", exact: true}),
    poseCard.locator("button[aria-pressed]"),
    backgroundCard.getByRole("button", {name: "Rename Sky", exact: true}),
    backgroundCard.getByRole("button", {name: "Delete Sky", exact: true}),
    backgroundCard.locator("button[aria-pressed]"),
    // A bundled card is a select control in the same fieldset.
    page.locator(".pose-grid").first().getByRole("button", {name: /Panic/u}),
  ];

  // Positive control: every control is enabled before the render.
  for (const control of controls) {
    await expect(control).toBeEnabled();
  }

  // Issue #24: mute before anything can play.
  await page.getByRole("button", {name: "Mute sound"}).click();

  const downloadPromise = page.waitForEvent("download", {timeout: 150_000});

  await page.getByRole("button", {name: "Render MP4"}).click();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-render-state",
    "rendering",
    {timeout: 30_000},
  );
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-authoring-locked",
    "true",
  );

  for (const control of controls) {
    await expect(control).toBeDisabled();
  }

  // Let the render finish (cancelling mid-render ends in a cleanup retry, which
  // is not what this test is about): the controls come back, the library stays.
  await downloadPromise;
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-render-state",
    "success",
    {timeout: 60_000},
  );
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-authoring-locked",
    "false",
  );

  for (const control of controls) {
    await expect(control).toBeEnabled();
  }

  await expect(
    poseSection.getByRole("heading", {name: "My assets · 1"}),
  ).toBeVisible();
  expect(await listRemotionOpfsEntries(page)).toEqual([]);
});
