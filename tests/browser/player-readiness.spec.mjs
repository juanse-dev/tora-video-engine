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


test("built Player surfaces font failure without unhandled rejection", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__toraUnhandledRejections = [];
    window.addEventListener("unhandledrejection", (event) => {
      window.__toraUnhandledRejections.push(
        event.reason instanceof Error
          ? event.reason.message
          : String(event.reason),
      );
    });
  });

  let releaseFontRequest;
  let fontRequestSeen = false;

  await page.route("**/*.woff2", async (route) => {
    fontRequestSeen = true;

    await new Promise((resolve) => {
      releaseFontRequest = resolve;
    });

    await route.abort("failed");
  });

  await page.goto("/", {waitUntil: "domcontentloaded"});

  await expect
    .poll(() => fontRequestSeen, {timeout: 10_000})
    .toBe(true);

  const frameProbe = page.locator("[data-tora-frame]").first();
  const playButton = page.getByRole("button", {name: "Play video"});

  await expect(playButton).toBeVisible();
  await playButton.click();

  await page.waitForTimeout(500);

  expect(
    Number(await frameProbe.getAttribute("data-tora-frame")),
  ).toBe(0);

  releaseFontRequest();

  await expect(page.getByRole("alert")).toContainText(
    "Preview unavailable:",
  );

  await page.waitForTimeout(500);

  expect(
    Number(await frameProbe.getAttribute("data-tora-frame")),
  ).toBe(0);

  await expect(
    page.getByRole("button", {name: "Play video"}),
  ).toBeVisible();

  expect(
    await page.evaluate(() => window.__toraUnhandledRejections),
  ).toEqual([]);
});


test("built Player recovers when a later caption generation loads after a font failure", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__toraUnhandledRejections = [];

    window.addEventListener("unhandledrejection", (event) => {
      window.__toraUnhandledRejections.push(
        event.reason instanceof Error
          ? event.reason.message
          : String(event.reason),
      );
    });

    Object.defineProperty(document.fonts, "load", {
      configurable: true,
      value: (_font, text) => {
        if (text.includes("Tora tiene una regla.")) {
          return Promise.reject(new Error("forced initial font failure"));
        }

        return Promise.resolve([{}]);
      },
    });
  });

  await page.goto("/", {waitUntil: "domcontentloaded"});

  const preview = page.locator(".preview-frame");
  const fontError = preview.locator("[data-preview-font-error]");

  await expect(fontError).toContainText(
    "Preview unavailable: forced initial font failure",
  );

  const caption = page.getByLabel("Caption");
  await caption.fill("Recovered caption");

  await expect(fontError).toHaveCount(0);
  await expect(preview.getByText("Recovered caption")).toBeVisible();

  const playButton = page.getByRole("button", {name: "Play video"});
  await playButton.click();

  const frameProbe = page.locator("[data-tora-frame]").first();

  await expect
    .poll(
      async () =>
        Number(await frameProbe.getAttribute("data-tora-frame")),
      {timeout: 10_000},
    )
    .toBeGreaterThan(0);

  expect(
    await page.evaluate(() => window.__toraUnhandledRejections),
  ).toEqual([]);
});
