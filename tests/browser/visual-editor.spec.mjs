import {expect, test} from "@playwright/test";

test("valid visual edits commit while invalid drafts keep the last active preview", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});

  const caption = page.getByLabel("Caption");
  const status = page.locator("[data-editor-status]");
  const preview = page.locator(".preview-frame");

  await expect(caption).toHaveValue("Tora tiene una regla.");
  await caption.fill("");

  await expect(status).toHaveAttribute(
    "data-editor-status",
    "schema-invalid",
  );
  await expect(preview.getByText("Tora tiene una regla.")).toBeVisible();

  await caption.fill("WEB-003 live caption");

  await expect(status).toHaveAttribute("data-editor-status", "eligible");
  await expect(preview.getByText("WEB-003 live caption")).toBeVisible();
});

test("scene add/delete/reorder operations stay inside the visual draft", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});

  await expect(page.getByText("Scenes (4)")).toBeVisible();
  await page.getByRole("button", {name: "Add scene"}).click();
  await expect(page.getByText("Scenes (5)")).toBeVisible();

  const selected = page.locator(".scene-list-item.selected");
  await expect(selected).toContainText("New scene");

  await page.getByRole("button", {name: "Move scene up"}).click();
  await expect(page.locator(".scene-list-item").nth(3)).toContainText(
    "New scene",
  );

  await page.getByRole("button", {name: "Delete"}).click();
  await expect(page.getByText("Scenes (4)")).toBeVisible();
});

test("rapid caption generations cannot let stale font loads unblock the newest Story", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const requests = [];
    window.__toraFontLoads = requests;

    FontFaceSet.prototype.load = function (_font, text) {
      return new Promise((resolve) => {
        requests.push({
          text,
          release: () => resolve([{}]),
        });
      });
    };
  });

  await page.goto("/", {waitUntil: "domcontentloaded"});

  await expect
    .poll(() =>
      page.evaluate(() => window.__toraFontLoads.length),
    )
    .toBe(3);

  const caption = page.getByLabel("Caption");

  await caption.fill("Alpha");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__toraFontLoads.filter((request) =>
            request.text.startsWith("Alpha\n"),
          ).length,
      ),
    )
    .toBe(3);

  await caption.fill("Beta");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__toraFontLoads.filter((request) =>
            request.text.startsWith("Beta\n"),
          ).length,
      ),
    )
    .toBe(3);

  await caption.fill("Gamma");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__toraFontLoads.filter((request) =>
            request.text.startsWith("Gamma\n"),
          ).length,
      ),
    )
    .toBe(3);

  await page.evaluate(() => {
    for (const request of window.__toraFontLoads) {
      if (!request.text.startsWith("Gamma\n")) {
        request.release();
      }
    }
  });

  const playButton = page.getByRole("button", {name: "Play video"});
  await playButton.click();
  const frameProbe = page.locator("[data-tora-frame]").first();

  await page.waitForTimeout(500);
  expect(Number(await frameProbe.getAttribute("data-tora-frame"))).toBe(0);

  await page.evaluate(() => {
    for (const request of window.__toraFontLoads) {
      if (request.text.startsWith("Gamma\n")) {
        request.release();
      }
    }
  });

  await expect
    .poll(async () =>
      Number(await frameProbe.getAttribute("data-tora-frame")),
    )
    .toBeGreaterThan(0);
});
