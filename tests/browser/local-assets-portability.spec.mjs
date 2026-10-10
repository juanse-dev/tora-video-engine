import {readFile} from "node:fs/promises";
import {expect, test} from "@playwright/test";
import {
  blobImages,
  cardFor,
  exportActiveYaml,
  fixtureUpload,
  importInput,
  importYamlFile,
  localRefsIn,
  missingCard,
  previewPlaceholders,
  renderBanner,
  statusLine,
  yamlSource,
} from "./helpers/localAssetFlows.mjs";
import {waitForOwner} from "./helpers/localAssetPage.mjs";
import {
  localAssetRef,
  readFixture,
} from "./helpers/seedAssetLibrary.mjs";

// ASSET-006 task A2: a Story that uses local assets travels as plain YAML to a
// fresh browser profile, and bundled-only projects stay byte-compatible with
// v0.2 (fixtures in tests/fixtures/v0.2, generated from commit 962e030).
// tests/v02-fixtures.test.mjs checks the same fixtures against the current
// serializers; this file checks what the app really imports, shows and exports.

const STORAGE_KEY = "tora-video-engine:project";
const V02_DIR = new URL("../fixtures/v0.2/", import.meta.url);
const STORIES_DIR = new URL("../../stories/", import.meta.url);

const readV02 = (name) => readFile(new URL(name, V02_DIR), "utf8");
const readStory = (name) => readFile(new URL(name, STORIES_DIR), "utf8");

const titleOf = (yaml) => /^title: (.+)$/mu.exec(yaml)[1];
const captionOfFirstScene = (yaml) => /^ {4}text: (.+)$/mu.exec(yaml)[1].replace(/^"|"$/gu, "");

const newProfile = async (browser, baseURL) => {
  const context = await browser.newContext({baseURL});
  const page = await context.newPage();

  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  return {context, page};
};

test("a Story with two local assets exports as plain YAML and resolves in a fresh profile only after Import matching file", async ({
  baseURL,
  browser,
}) => {
  const pose = await readFixture("pose-magenta.png");
  const background = await readFixture("background-cyan.jpg");
  const poseRef = localAssetRef("pose", pose.digest);
  const backgroundRef = localAssetRef("background", background.digest);
  const friday = await readV02("friday-deploy.yaml");

  // --- Context A: import both fixtures, apply them, export the YAML ----------
  const a = await newProfile(browser, baseURL);
  let exported;

  try {
    await importInput(a.page, "pose").setInputFiles(fixtureUpload(pose));
    await expect(statusLine(a.page, "pose")).toHaveText('Imported "pose-magenta".');
    await importInput(a.page, "background").setInputFiles(
      fixtureUpload(background),
    );
    await expect(statusLine(a.page, "background")).toHaveText(
      'Imported "background-cyan".',
    );
    await expect(blobImages(a.page)).toHaveCount(2);
    await expect(previewPlaceholders(a.page)).toHaveCount(0);

    exported = await exportActiveYaml(a.page);
  } finally {
    await a.context.close();
  }

  const yaml = exported.text;

  // The YAML carries exactly the two refs and nothing that identifies bytes,
  // blob URLs or the local machine.
  expect(localRefsIn(yaml)).toEqual([poseRef, backgroundRef]);
  expect(yaml).not.toMatch(/blob:|data:|base64|file:|\\|[A-Za-z]:[\\/]/iu);
  expect(yaml).not.toContain("pose-magenta");
  expect(yaml).not.toContain("background-cyan");
  expect(yaml).not.toContain("fixtures");
  // Everything else is the v0.2 export of the default Story: only scene 1's
  // pose and background changed.
  expect(yaml).toBe(
    friday
      .replace("pose: formal", `pose: ${poseRef}`)
      .replace("background: office", `background: ${backgroundRef}`),
  );

  // The CLI's CI Story uses the same fixture digests as the refs produced here.
  expect(localRefsIn(await readStory("ci-local-assets.yaml"))).toEqual([
    poseRef,
    backgroundRef,
  ]);

  // --- Context B: a new profile has neither asset ----------------------------
  const b = await newProfile(browser, baseURL);

  try {
    await expect(b.page.locator("[data-my-assets] [data-local-asset-card]")).toHaveCount(0);
    await importYamlFile(b.page, exported.filename, yaml);

    // The Story is valid and active: the YAML editor holds it unchanged.
    await expect(b.page.locator(".app-shell")).toHaveAttribute(
      "data-editor-mode",
      "visual",
    );
    expect(await yamlSource(b.page)).toBe(yaml);

    // Both refs are missing: recovery cards, Player placeholders, render blocked.
    await expect(missingCard(b.page, poseRef)).toContainText("Missing local pose");
    await expect(missingCard(b.page, backgroundRef)).toContainText(
      "Missing local background",
    );
    await expect(previewPlaceholders(b.page)).toHaveCount(2);
    await expect(blobImages(b.page)).toHaveCount(0);
    await expect(renderBanner(b.page)).toHaveAttribute(
      "data-local-asset-block",
      /local asset\(s\) are unavailable/u,
    );
    // (Render MP4 is disabled in bundled Chromium whatever the assets, so the
    // button says nothing here; the block above is the real render check.)

    // Import matching file with the exact fixtures resolves each ref without
    // touching the Story.
    await missingCard(b.page, poseRef)
      .locator('input[type="file"]')
      .setInputFiles(fixtureUpload(pose));
    await expect(statusLine(b.page, "pose")).toHaveText('Imported "pose-magenta".');
    await expect(missingCard(b.page, poseRef)).toHaveCount(0);
    await expect(cardFor(b.page, "pose", pose.digest)).toContainText("Current");
    await expect(previewPlaceholders(b.page)).toHaveCount(1);
    expect(await yamlSource(b.page)).toBe(yaml);

    await missingCard(b.page, backgroundRef)
      .locator('input[type="file"]')
      .setInputFiles(fixtureUpload(background));
    await expect(statusLine(b.page, "background")).toHaveText(
      'Imported "background-cyan".',
    );
    await expect(missingCard(b.page, backgroundRef)).toHaveCount(0);
    await expect(cardFor(b.page, "background", background.digest)).toContainText(
      "Current",
    );
    expect(await yamlSource(b.page)).toBe(yaml);

    // Render is eligible: the local-asset block is gone and nothing is missing.
    // (Bundled Chromium reports browser render unsupported, so the Render MP4
    // button itself is not asserted here; the render is proven in ASSET-004.)
    await expect(previewPlaceholders(b.page)).toHaveCount(0);
    await expect(b.page.locator("[data-missing-local-asset]")).toHaveCount(0);
    await expect(blobImages(b.page)).toHaveCount(2);
    await expect(renderBanner(b.page)).not.toHaveAttribute(
      "data-local-asset-block",
      /.+/u,
    );
    await expect(renderBanner(b.page)).toHaveAttribute("data-render-state", "idle");
  } finally {
    await b.context.close();
  }
});

// --- v0.2 compatibility ---------------------------------------------------------

const BUNDLED_STORIES = ["friday-deploy", "ci-smoke", "demo-reel"];

for (const name of BUNDLED_STORIES) {
  test(`v0.2 compatibility: stories/${name}.yaml imports, previews and exports byte-identically to v0.2`, async ({
    page,
  }) => {
    const source = await readStory(`${name}.yaml`);
    const v02 = await readV02(`${name}.yaml`);
    const firstCaption = captionOfFirstScene(v02);

    // Start from a different bundled Story, so the import really replaces it.
    const other = name === "ci-smoke" ? "demo-reel" : "ci-smoke";

    await page.goto("/", {waitUntil: "domcontentloaded"});
    await waitForOwner(page);
    await importYamlFile(page, `${other}.yaml`, await readStory(`${other}.yaml`));
    expect(await yamlSource(page)).toBe(await readV02(`${other}.yaml`));
    expect(await yamlSource(page)).not.toBe(v02);
    await importYamlFile(page, `${name}.yaml`, source);

    // Import: the Story is active and the editor holds the v0.2 text.
    await expect(page.locator("[data-import-candidate]")).toHaveCount(0);
    expect(await yamlSource(page)).toBe(v02);

    // Preview: the first scene's caption is in the Player, with no local asset
    // machinery in play.
    await expect
      .poll(() =>
        page
          .locator(".preview-frame [data-caption-line]")
          .allTextContents()
          .then((lines) => lines.join(" ")),
      )
      .toBe(firstCaption);
    await expect(previewPlaceholders(page)).toHaveCount(0);
    await expect(blobImages(page)).toHaveCount(0);
    await expect(renderBanner(page)).not.toHaveAttribute(
      "data-local-asset-block",
      /.+/u,
    );

    // Export: byte-identical to v0.2.
    const exported = await exportActiveYaml(page);

    expect(exported.text).toBe(v02);

    // Bundled-only Stories persist as version 1, which v0.2 can still read.
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY))
      .toContain(`"title":${JSON.stringify(titleOf(v02))}`);
    expect(
      JSON.parse(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY))
        .version,
    ).toBe(1);
  });
}

test("a v1 envelope written by v0.2 restores and stays v1 after bundled edits", async ({
  page,
}) => {
  const envelope = await readV02("project-envelope.json");

  expect(JSON.parse(envelope).version).toBe(1);

  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key, value),
    [STORAGE_KEY, envelope],
  );
  await page.reload({waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  // Restored: the v0.2 Story is active, with no recovery banner.
  await expect(page.locator(".recovery-banner")).toHaveCount(0);
  await expect(page.getByLabel("Caption")).toHaveValue("Written by v0.2");
  expect(await yamlSource(page)).toContain("text: Written by v0.2");
  // The stored bytes are still v0.2's (restoring did not rewrite them).
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe(
    envelope,
  );

  // Bundled edits: a new caption, then a bundled pose and background.
  await page.getByLabel("Caption").fill("Edited in v0.3");
  await page.getByRole("button", {name: /Panic/u}).first().click();
  await page.getByRole("button", {name: /Server room/iu}).first().click();

  // The caption, pose and background edits autosave separately, so wait until
  // the stored scene 0 holds all three before asserting (waiting for the
  // caption alone raced the later pose and background saves).
  const readStoredEnvelope = () =>
    page
      .evaluate((key) => localStorage.getItem(key), STORAGE_KEY)
      .then((raw) => (raw ? JSON.parse(raw) : null));

  await expect
    .poll(async () => (await readStoredEnvelope())?.story?.scenes?.[0] ?? null)
    .toMatchObject({
      text: "Edited in v0.3",
      pose: "panic",
      background: "server-room",
    });

  const stored = await readStoredEnvelope();

  expect(stored.version).toBe(1);
  expect(localRefsIn(JSON.stringify(stored))).toEqual([]);

  // And it survives a reload.
  await page.reload({waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await expect(page.getByLabel("Caption")).toHaveValue("Edited in v0.3");
});
