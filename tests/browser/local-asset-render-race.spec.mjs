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

/**
 * Opens page A with the seeded pose Story applied and ready to render.
 * `blindLockPoll` makes the page's render-lock availability poll report "free"
 * (it only reads `navigator.locks.query`), so the Render button stays enabled
 * while another tab holds the lock and a click reaches the transaction itself.
 */
const openPoseStory = async (
  context,
  duration = 1,
  {blindLockPoll = false} = {},
) => {
  const pose = await readFixture("pose-magenta.png");
  const poseRef = localAssetRef("pose", pose.digest);
  const pageA = await context.newPage();

  if (blindLockPoll) {
    await pageA.addInitScript(() => {
      navigator.locks.query = async () => ({held: [], pending: []});
    });
  }

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

  const {pageA, poseRef} = await openPoseStory(context, 1, {
    blindLockPoll: true,
  });
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

  // The poll is blind, so the button is enabled and the click reaches
  // startBrowserRenderTransaction, whose non-blocking lock request is refused.
  const renderButton = pageA.getByRole("button", {name: "Render MP4"});

  await expect(renderButton).toBeEnabled();
  await renderButton.click();
  await expect(pageA.locator(".render-banner")).toContainText(
    /Another Tora tab (is rendering|owns the browser render lock)\./u,
    {timeout: 10_000},
  );
  await expect(pageA.locator(".app-shell")).toHaveAttribute(
    "data-render-state",
    "idle",
  );
  expect(await listRemotionOpfsEntries(pageA)).toEqual([]);

  await deleteAssetRows(pageB, [poseRef]);
  await pageB.evaluate(() => window.__releaseRenderLock());

  await expect(renderButton).toBeEnabled();
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

  const {pageA, poseRef} = await openPoseStory(context, 3);
  const pageB = await context.newPage();

  await pageB.goto("/", {waitUntil: "domcontentloaded"});

  const downloadPromise = pageA.waitForEvent("download", {timeout: 150_000});

  await pageA.getByRole("button", {name: "Render MP4"}).click();
  await expect(
    pageA.locator("progress[aria-label='Browser render progress']"),
  ).toBeVisible({timeout: 30_000});

  await deleteAssetRows(pageB, [poseRef]);

  // The deletion must land inside the render window, or the test proves nothing.
  await expect(pageA.locator(".app-shell")).toHaveAttribute(
    "data-render-state",
    "rendering",
  );

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
