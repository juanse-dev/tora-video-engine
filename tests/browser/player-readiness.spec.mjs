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

  await page.goto("/", {waitUntil: "domcontentloaded"});

  await expect
    .poll(() => delayedRequests.length, {timeout: 10_000})
    .toBeGreaterThan(0);

  const playButton = page.getByRole("button", {name: "Play video"});
  await expect(playButton).toBeVisible();
  await playButton.click();

  const frameProbe = page.locator("[data-tora-frame]").first();

  await expect
    .poll(
      async () =>
        Number(await frameProbe.getAttribute("data-tora-frame")),
      {timeout: 10_000},
    )
    .toBe(0);

  await page.waitForTimeout(500);

  expect(
    Number(await frameProbe.getAttribute("data-tora-frame")),
  ).toBe(0);

  for (const request of delayedRequests) {
    request.release();
  }

  await expect
    .poll(
      async () =>
        Number(await frameProbe.getAttribute("data-tora-frame")),
      {timeout: 10_000},
    )
    .toBeGreaterThan(0);
};

test("built Player waits for the caption font before advancing", async ({
  page,
}) => {
  await runBlockedPlaybackCase({
    page,
    shouldDelay: (url) => url.endsWith(".woff2"),
  });
});

test("built Player waits for scene images before advancing", async ({
  page,
}) => {
  await runBlockedPlaybackCase({
    page,
    shouldDelay: (url) =>
      url.includes("/characters/tora/") ||
      url.includes("/backgrounds/"),
  });
});
