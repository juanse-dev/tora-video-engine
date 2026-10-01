import {expect, test} from "@playwright/test";

const runBlockedPlaybackCase = async ({page, shouldDelay}) => {
  const delayedRequests = [];

  await page.route("**/*", async (route) => {
    const url = route.request().url();

    if (!shouldDelay(url)) {
      await route.continue();
      return;
    }

    let release;
    const released = new Promise((resolve) => {
      release = resolve;
    });

    delayedRequests.push({release, url});
    await released;
    await route.continue();
  });

  await page.goto("/tests/browser/readiness.html", {
    waitUntil: "domcontentloaded",
  });

  await expect
    .poll(() => delayedRequests.length, {timeout: 10_000})
    .toBeGreaterThan(0);

  await expect
    .poll(
      () =>
        page.evaluate(() => window.__toraPlayer?.getCurrentFrame() ?? null),
      {timeout: 10_000},
    )
    .toBe(0);

  await page.waitForTimeout(500);

  expect(
    await page.evaluate(
      () => window.__toraPlayer?.getCurrentFrame() ?? null,
    ),
  ).toBe(0);

  for (const request of delayedRequests) {
    request.release();
  }

  await expect
    .poll(
      () =>
        page.evaluate(() => window.__toraPlayer?.getCurrentFrame() ?? 0),
      {timeout: 10_000},
    )
    .toBeGreaterThan(0);
};

test("Player waits for the caption font before advancing", async ({page}) => {
  await runBlockedPlaybackCase({
    page,
    shouldDelay: (url) => url.endsWith(".woff2"),
  });
});

test("Player waits for scene images before advancing", async ({page}) => {
  await runBlockedPlaybackCase({
    page,
    shouldDelay: (url) =>
      url.includes("/characters/tora/") ||
      url.includes("/backgrounds/"),
  });
});
