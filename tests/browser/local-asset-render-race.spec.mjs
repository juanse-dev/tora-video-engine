import {expect, test} from "@playwright/test";
import {
  applyYaml,
  countMagentaPixels,
  decodeMp4Frame,
  isBrowserRenderSupported,
  listRemotionOpfsEntries,
  meanLuminance,
  openSeeded,
} from "./helpers/localAssetPage.mjs";
import {
  buildStoryYaml,
  deleteAssetRows,
  fixtureRecord,
  localAssetRef,
  readFixture,
} from "./helpers/seedAssetLibrary.mjs";

const RENDER_LOCK = "tora-video-engine:web-fs-render";

const requireRenderSupport = async (page) => {
  if (!(await isBrowserRenderSupported(page))) {
    test.skip(true, "Browser web rendering is unavailable in this runtime");
  }
};

/** Opens page A with the seeded pose Story applied and ready to render. */
const openPoseStory = async (context, duration = 1) => {
  const pose = await readFixture("pose-magenta.png");
  const poseRef = localAssetRef("pose", pose.digest);
  const pageA = await context.newPage();

  await openSeeded(pageA, [fixtureRecord("pose", pose)]);
  await requireRenderSupport(pageA);
  await applyYaml(
    pageA,
    buildStoryYaml([{pose: poseRef, background: "office"}]).replace(
      "duration: 3",
      `duration: ${duration}`,
    ),
  );
  await expect(pageA.locator(".preview-frame img[src^='blob:']")).toHaveCount(1);
  await expect(pageA.getByRole("button", {name: "Render MP4"})).toBeEnabled();

  return {pageA, pose, poseRef};
};

test("a busy render lock, then a pose deleted in another tab, blocks the retry with the missing-asset message and no OPFS entry", async ({
  context,
}) => {
  test.setTimeout(90_000);

  const {pageA, poseRef} = await openPoseStory(context);
  const pageB = await context.newPage();

  await pageB.goto("/", {waitUntil: "domcontentloaded"});
  await pageB.evaluate(
    (name) =>
      new Promise((resolve) => {
        void navigator.locks.request(
          name,
          () =>
            new Promise((release) => {
              window.__releaseRenderLock = release;
              resolve();
            }),
        );
      }),
    RENDER_LOCK,
  );

  // The page polls the lock once a second, so the button may already be
  // disabled; either way the busy message must show and nothing may render.
  await pageA
    .getByRole("button", {name: "Render MP4"})
    .click({timeout: 1_500})
    .catch(() => {});
  await expect(pageA.locator(".render-banner")).toContainText(
    "Another Tora tab owns the browser render lock.",
    {timeout: 10_000},
  );

  await deleteAssetRows(pageB, [poseRef]);
  await pageB.evaluate(() => window.__releaseRenderLock());

  const renderButton = pageA.getByRole("button", {name: "Render MP4"});

  // The lock poll re-enables the button once tab B released the render lock.
  await expect(renderButton).toBeEnabled({timeout: 10_000});
  await renderButton.click();

  await expect(pageA.locator(".render-banner")).toContainText(
    "Browser render is blocked because 1 local asset(s) are unavailable in this browser.",
  );
  await expect(pageA.locator(".app-shell")).toHaveAttribute(
    "data-authoring-locked",
    "false",
  );
  expect(await listRemotionOpfsEntries(pageA)).toEqual([]);
});

test("a pose deleted after the render started does not affect it, and shows as missing afterwards without reload", async ({
  context,
}) => {
  test.setTimeout(180_000);

  const {pageA, poseRef} = await openPoseStory(context, 10);
  const pageB = await context.newPage();

  await pageB.goto("/", {waitUntil: "domcontentloaded"});

  const downloadPromise = pageA.waitForEvent("download", {timeout: 150_000});

  await pageA.getByRole("button", {name: "Render MP4"}).click();
  await expect(
    pageA.locator("progress[aria-label='Browser render progress']"),
  ).toBeVisible({timeout: 30_000});

  await deleteAssetRows(pageB, [poseRef]);

  const download = await downloadPromise;
  const path = await download.path();

  expect(path).not.toBeNull();
  await expect(pageA.locator(".app-shell")).toHaveAttribute(
    "data-render-state",
    "success",
    {timeout: 60_000},
  );

  const frame = await decodeMp4Frame(path, 0.5);

  // Positive control: the frame is not black (bundled background is drawn).
  expect(meanLuminance(frame)).toBeGreaterThan(10);
  expect(countMagentaPixels(frame)).toBeGreaterThan(500);

  // The deletion made during the render shows up without a reload.
  await expect(pageA.locator("[data-missing-local-asset]")).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(pageA.getByRole("button", {name: "Render MP4"})).toBeDisabled();
});
