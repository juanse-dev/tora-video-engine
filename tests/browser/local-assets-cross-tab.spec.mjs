import {expect, test} from "@playwright/test";
import {
  blobImages,
  cardFor,
  cards,
  fixtureUpload,
  importInput,
  missingCard,
  previewPlaceholders,
  readLibraryRecords,
  renderBanner,
  section,
  statusLine,
  yamlSource,
} from "./helpers/localAssetFlows.mjs";
import {applyYaml, waitForOwner} from "./helpers/localAssetPage.mjs";
import {
  buildStoryYaml,
  localAssetRef,
  readFixture,
} from "./helpers/seedAssetLibrary.mjs";

// ASSET-006 task A3: two tabs of one browser profile converge on the same
// library. Tab A opens first and owns Story persistence; tab B is a secondary
// tab (its Story stays in memory) but shares the IndexedDB library and hears
// A's changes over the BroadcastChannel, without a reload.

/** Opens A (the persistence owner) and then B (secondary) on the same profile. */
const openTwoTabs = async (context, page) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const secondary = await context.newPage();

  await secondary.goto("/", {waitUntil: "domcontentloaded"});
  await expect(secondary.locator(".app-shell")).toHaveAttribute(
    "data-persistence-mode",
    "secondary",
    {timeout: 10_000},
  );

  // Both libraries are open and empty before anything is imported.
  for (const tab of [page, secondary]) {
    await expect(importInput(tab, "pose")).toBeEnabled();
    await expect(
      section(tab, "pose").getByRole("heading", {name: "My assets · 0"}),
    ).toBeVisible();
  }

  return secondary;
};

const label = (page, category, digest) =>
  cardFor(page, category, digest).locator(".asset-card-copy strong");

test("an import in tab A appears in tab B's My assets without a reload", async ({
  context,
  page,
}) => {
  const pose = await readFixture("pose-magenta.png");
  const background = await readFixture("background-cyan.jpg");
  const b = await openTwoTabs(context, page);

  // B has no navigation after this point: any card it shows came from A.
  await b.evaluate(() => {
    window.__tabBMarker = "never reloaded";
  });

  await importInput(page, "pose").setInputFiles(fixtureUpload(pose));
  await expect(statusLine(page, "pose")).toHaveText('Imported "pose-magenta".');

  await expect(cards(b, "pose")).toHaveCount(1);
  await expect(label(b, "pose", pose.digest)).toHaveText("pose-magenta");
  await expect(
    section(b, "pose").getByRole("heading", {name: "My assets · 1"}),
  ).toBeVisible();
  // The other category is untouched.
  await expect(cards(b, "background")).toHaveCount(0);

  await importInput(page, "background").setInputFiles(fixtureUpload(background));
  await expect(statusLine(page, "background")).toHaveText(
    'Imported "background-cyan".',
  );
  await expect(cards(b, "background")).toHaveCount(1);
  await expect(label(b, "background", background.digest)).toHaveText(
    "background-cyan",
  );

  // B is the same document it was: not reloaded, and its own Story is untouched
  // (A applied the assets to A's Story, not B's).
  expect(await b.evaluate(() => window.__tabBMarker)).toBe("never reloaded");
  expect(await yamlSource(b)).not.toContain("local:");
  await expect(cardFor(b, "pose", pose.digest)).not.toContainText("Current");
});

test("a rename in tab A updates tab B's label and leaves B's Story YAML unchanged", async ({
  context,
  page,
}) => {
  const pose = await readFixture("pose-magenta.png");
  const poseRef = localAssetRef("pose", pose.digest);
  const b = await openTwoTabs(context, page);

  await importInput(page, "pose").setInputFiles(fixtureUpload(pose));
  await expect(statusLine(page, "pose")).toHaveText('Imported "pose-magenta".');
  await expect(label(b, "pose", pose.digest)).toHaveText("pose-magenta");

  // B uses the asset in its own Story.
  await applyYaml(
    b,
    buildStoryYaml([{pose: poseRef, background: "office"}], "Tab B Story"),
  );
  await b.getByRole("button", {name: "Open visual editor"}).click();
  await expect(blobImages(b)).toHaveCount(1);

  const before = await yamlSource(b);

  expect(before).toContain(`pose: ${poseRef}`);

  // A renames the asset.
  const cardA = cardFor(page, "pose", pose.digest);

  await cardA
    .getByRole("button", {name: "Rename pose-magenta", exact: true})
    .click();
  await cardA.getByRole("textbox").fill("Renamed in A");
  await cardA.getByRole("textbox").press("Enter");
  await expect(label(page, "pose", pose.digest)).toHaveText("Renamed in A");

  // B's card shows the new label; the ref, its Story and its Player do not change.
  await expect(label(b, "pose", pose.digest)).toHaveText("Renamed in A");
  await expect(cards(b, "pose")).toHaveCount(1);
  await expect(cardFor(b, "pose", pose.digest)).toContainText("Current");
  expect(await yamlSource(b)).toBe(before);
  await expect(blobImages(b)).toHaveCount(1);
  await expect(previewPlaceholders(b)).toHaveCount(0);
  await expect(missingCard(b, poseRef)).toHaveCount(0);
});

test("deleting an in-use asset in tab A leaves tab B with the missing card and a Player placeholder", async ({
  context,
  page,
}) => {
  const pose = await readFixture("pose-magenta.png");
  const poseRef = localAssetRef("pose", pose.digest);
  const b = await openTwoTabs(context, page);

  await importInput(page, "pose").setInputFiles(fixtureUpload(pose));
  await expect(statusLine(page, "pose")).toHaveText('Imported "pose-magenta".');
  await expect(cardFor(b, "pose", pose.digest)).toBeVisible();

  await applyYaml(
    b,
    buildStoryYaml([{pose: poseRef, background: "office"}], "Tab B Story"),
  );
  await b.getByRole("button", {name: "Open visual editor"}).click();
  await expect(blobImages(b)).toHaveCount(1);
  await expect(renderBanner(b)).not.toHaveAttribute(
    "data-local-asset-block",
    /.+/u,
  );

  const before = await yamlSource(b);

  // A deletes it; the asset is in use in A's Story too, so A asks first.
  const dialog = page.getByRole("dialog");

  await cardFor(page, "pose", pose.digest)
    .getByRole("button", {name: "Delete pose-magenta", exact: true})
    .click();
  await dialog.getByRole("button", {name: "Delete asset anyway"}).click();
  await expect(dialog).toHaveCount(0);
  await expect(cards(page, "pose")).toHaveCount(0);

  // B converges: no card, a missing recovery card, a placeholder, render blocked.
  await expect(cards(b, "pose")).toHaveCount(0);
  await expect(
    section(b, "pose").getByRole("heading", {name: "My assets · 0"}),
  ).toBeVisible();
  await expect(missingCard(b, poseRef)).toContainText("Missing local pose");
  await expect(previewPlaceholders(b)).toHaveCount(1);
  await expect(previewPlaceholders(b)).toHaveAttribute(
    "data-missing-local-asset",
    poseRef,
  );
  await expect(blobImages(b)).toHaveCount(0);
  await expect(renderBanner(b)).toHaveAttribute(
    "data-local-asset-block",
    /local asset\(s\) are unavailable/u,
  );
  await expect(b.getByRole("button", {name: "Render MP4"})).toBeDisabled();
  // Deleting never edits a Story.
  expect(await yamlSource(b)).toBe(before);
});

test("the same file imported in both tabs at nearly the same time leaves one card and one payload", async ({
  context,
  page,
}) => {
  const pose = await readFixture("pose-magenta.png");
  const poseRef = localAssetRef("pose", pose.digest);
  const b = await openTwoTabs(context, page);

  // Both uploads are issued back to back, before either tab has finished.
  await Promise.all([
    importInput(page, "pose").setInputFiles(fixtureUpload(pose)),
    importInput(b, "pose").setInputFiles(fixtureUpload(pose)),
  ]);

  // One tab imports it; the other finds it already stored. Either order is fine.
  for (const tab of [page, b]) {
    await expect(statusLine(tab, "pose")).toHaveText(
      /^(Imported "pose-magenta"\.|"pose-magenta" was already in My assets; its stored copy was refreshed\.)$/u,
    );
    await expect(cards(tab, "pose")).toHaveCount(1);
    await expect(
      section(tab, "pose").getByRole("heading", {name: "My assets · 1"}),
    ).toBeVisible();
    await expect(cards(tab, "pose").first()).toHaveAttribute(
      "data-local-asset-card",
      poseRef,
    );
  }

  // The library itself holds one assets row and one payload (metadata + blob).
  for (const tab of [page, b]) {
    expect(await readLibraryRecords(tab, poseRef, pose.digest)).toEqual({
      assetRows: 1,
      allAssetRows: 1,
      payloadMeta: 1,
      blobs: 1,
      allBlobs: 1,
    });
  }
});
