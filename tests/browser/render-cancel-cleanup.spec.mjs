import {expect, test} from "@playwright/test";
import {
  isBrowserRenderSupported,
  listRemotionOpfsEntries,
  waitForOwner,
} from "./helpers/localAssetPage.mjs";

// Issue #29. Real-browser contract for the render storage after Cancel Render
// and after a mid-render failure: the render settles in `idle` / `failure`
// (never `cleanup-blocked`), no `__remotion_render:` OPFS entry remains, and
// the next render succeeds.
//
// Bundled Chromium cannot encode H.264, so this file runs only under
// playwright.browser-render.config.mjs (system Chrome) and is ignored by the
// default config. There a missing render capability is a failure, not a skip:
// the specs must never pass vacuously.

const shell = (page) => page.locator(".app-shell");

const openRenderablePage = async (page) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  expect(
    await isBrowserRenderSupported(page),
    `Browser MP4 rendering must be ready in this runtime: ${await page
      .locator(".render-banner")
      .textContent()}`,
  ).toBe(true);
  await expect(page.getByRole("button", {name: "Render MP4"})).toBeEnabled();
};

const renderToCompletion = async (page) => {
  const downloadPromise = page.waitForEvent("download", {timeout: 120_000});

  await page.getByRole("button", {name: "Render MP4"}).click();

  const download = await downloadPromise;
  const path = await download.path();

  expect(path).not.toBeNull();
  await expect(shell(page)).toHaveAttribute("data-render-state", "success", {
    timeout: 30_000,
  });
  await expect(shell(page)).toHaveAttribute("data-authoring-locked", "false");
  expect(await listRemotionOpfsEntries(page)).toEqual([]);
};

test("Cancel Render settles idle with clean OPFS and the next render succeeds", async ({
  page,
}) => {
  test.setTimeout(180_000);

  await openRenderablePage(page);

  let downloaded = false;
  const onDownload = () => {
    downloaded = true;
  };

  page.on("download", onDownload);
  // Cancel now settles in a fraction of a second, so the transient
  // `cancelling` state can be gone before an assertion polls for it. Record
  // every state the shell goes through instead.
  await page.evaluate(() => {
    const target = document.querySelector(".app-shell");
    const seen = [target.getAttribute("data-render-state")];

    window.__renderStates = seen;
    new MutationObserver(() => {
      const state = target.getAttribute("data-render-state");

      if (seen[seen.length - 1] !== state) {
        seen.push(state);
      }
    }).observe(target, {
      attributes: true,
      attributeFilter: ["data-render-state"],
    });
  });
  await page.getByRole("button", {name: "Render MP4"}).click();
  await expect(shell(page)).toHaveAttribute("data-authoring-locked", "true");
  // Let the encode start so the cancel lands mid-render.
  await expect(page.locator(".render-banner")).toContainText(/Rendering MP4/);

  await page.getByRole("button", {name: "Cancel Render"}).click();
  await expect(shell(page)).toHaveAttribute("data-render-state", "idle", {
    timeout: 90_000,
  });

  const states = await page.evaluate(() => window.__renderStates);

  expect(states).toContain("cancelling");
  expect(states).not.toContain("success");
  expect(states).not.toContain("failure");
  expect(states).not.toContain("cleanup-blocked");
  await expect(shell(page)).toHaveAttribute("data-authoring-locked", "false");
  page.off("download", onDownload);
  expect(downloaded).toBe(false);
  expect(await listRemotionOpfsEntries(page)).toEqual([]);

  await renderToCompletion(page);
});

test("A mid-render failure settles failure with clean OPFS and the next render succeeds", async ({
  page,
}) => {
  test.setTimeout(180_000);

  // Throw once from a VideoFrame construction part-way through the encode, so
  // the renderer fails (it is not cancelled) after it opened its OPFS output.
  // The counter only runs once the test arms it right before clicking Render.
  await page.addInitScript(() => {
    const NativeVideoFrame = window.VideoFrame;
    const injection = {armed: false, constructed: 0, fired: false};

    window.__failureInjection = injection;
    window.VideoFrame = new Proxy(NativeVideoFrame, {
      construct(target, args, newTarget) {
        if (injection.armed && !injection.fired) {
          injection.constructed += 1;

          if (injection.constructed === 40) {
            injection.fired = true;
            throw new Error("injected mid-render failure");
          }
        }

        return Reflect.construct(target, args, newTarget);
      },
    });
  });

  await openRenderablePage(page);
  await page.evaluate(() => {
    window.__failureInjection.armed = true;
  });
  await page.getByRole("button", {name: "Render MP4"}).click();

  await expect(shell(page)).toHaveAttribute("data-render-state", "failure", {
    timeout: 90_000,
  });
  await expect(page.locator(".render-banner")).toContainText(
    "injected mid-render failure",
  );
  expect(
    await page.evaluate(() => window.__failureInjection.fired),
    "the injected failure must have fired",
  ).toBe(true);
  await expect(shell(page)).toHaveAttribute("data-authoring-locked", "false");
  expect(await listRemotionOpfsEntries(page)).toEqual([]);

  await renderToCompletion(page);
});
