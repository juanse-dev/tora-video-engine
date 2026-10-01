import {expect, test} from "@playwright/test";

test("Player waits for caption font and images before advancing", async ({
  page,
}) => {
  const delayedRequests = [];

  await page.route("**/*", async (route) => {
    const url = route.request().url();
    const shouldDelay =
      url.includes("/characters/tora/") ||
      url.includes("/backgrounds/") ||
      url.endsWith(".woff2");

    if (!shouldDelay) {
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

  await page.goto("/tests/browser/readiness.html");

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
});
