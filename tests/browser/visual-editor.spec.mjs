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
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-visual-state",
    "schema-invalid",
  );
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-visual-pending",
    "true",
  );
  await expect(preview.getByText("Tora tiene una regla.")).toBeVisible();

  await caption.fill("WEB-003 live caption");

  await expect(status).toHaveAttribute("data-editor-status", "eligible");
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-visual-state",
    "clean",
  );
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-visual-pending",
    "false",
  );
  await expect
    .poll(async () =>
      preview
        .locator("[data-caption-line]")
        .allTextContents()
        .then((lines) => lines.join(" ")),
    )
    .toBe("WEB-003 live caption");
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

    Object.defineProperty(document.fonts, "load", {
      configurable: true,
      value: (_font, text) =>
        new Promise((resolve) => {
          requests.push({
            text,
            release: () => resolve([{}]),
          });
        }),
    });
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


test("policy-rejected visual candidate is observable while Active Story stays mounted", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});

  const preview = page.locator(".preview-frame");
  const duration = page.getByLabel("Duration (seconds)");

  await expect(preview.getByText("Tora tiene una regla.")).toBeVisible();
  await duration.fill("301");

  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-visual-state",
    "policy-rejected",
  );
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-visual-pending",
    "true",
  );
  await expect(preview.getByText("Tora tiene una regla.")).toBeVisible();
});


test("asset catalog discovers and applies bundled visual assets", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});

  const catalog = page.getByRole("region", {name: "Available assets"});
  await expect(catalog).toBeVisible();

  for (const name of ["Formal", "Confused", "Panic", "Coffee"]) {
    await expect(
      catalog.getByRole("button", {name: new RegExp(name)}),
    ).toBeVisible();
  }

  for (const name of ["Office", "Server room"]) {
    await expect(
      catalog.getByRole("button", {name: new RegExp(name)}),
    ).toBeVisible();
  }

  for (const name of [
    "Auto / scene default",
    "Fade",
    "Float",
    "Slow zoom",
  ]) {
    await expect(
      catalog.getByRole("button", {name: new RegExp(name)}),
    ).toBeVisible();
  }

  const coffee = catalog.getByRole("button", {name: /Coffee/});
  await coffee.click();
  await expect(coffee).toHaveAttribute("aria-pressed", "true");

  const serverRoom = catalog.getByRole("button", {name: /Server room/});
  await serverRoom.click();
  await expect(serverRoom).toHaveAttribute("aria-pressed", "true");

  const slowZoom = catalog.getByRole("button", {name: /Slow zoom/});
  await slowZoom.click();
  await expect(slowZoom).toHaveAttribute("aria-pressed", "true");

  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-visual-state",
    "clean",
  );

  await expect(
    page.locator('.preview-frame img[src*="characters/tora/coffee.png"]'),
  ).toBeVisible();
  await expect(
    page.locator('.preview-frame img[src*="backgrounds/server-room.png"]'),
  ).toBeVisible();
});
