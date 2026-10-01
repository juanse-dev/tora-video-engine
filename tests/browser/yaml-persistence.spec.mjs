import {readFile} from "node:fs/promises";
import {expect, test} from "@playwright/test";

const assertDownloadPath = (path) => {
  expect(path).not.toBeNull();

  if (path === null) {
    throw new Error("Expected browser download path");
  }
};

const waitForOwner = async (page) => {
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-persistence-mode",
    "owner",
    {timeout: 10_000},
  );
};

test("YAML apply uses exact baseline and dirty YAML cannot silently enter visual mode", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  await page.getByRole("button", {name: "Open YAML"}).click();

  const source = page.getByLabel("YAML source");
  await expect(source).toContainText("title: Deploy Friday");

  const noncanonical = (await source.inputValue())
    .replace("title: Deploy Friday", "title: 'Deploy Friday'")
    .replace("Tora tiene una regla.", "Applied from YAML");

  await source.fill(noncanonical);
  await expect(page.locator("[data-yaml-dirty=true]")).toBeVisible();

  await page.getByRole("button", {name: "Apply YAML"}).click();

  await expect(page.locator("[data-yaml-dirty=false]")).toBeVisible();
  await expect(
    page.locator(".preview-frame").getByText("Applied from YAML"),
  ).toBeVisible();

  await source.fill("title: [broken");
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-render-blocked",
    "true",
  );

  await page.getByRole("button", {name: "Open visual editor"}).first().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("YAML has unapplied work");
  await expect(
    dialog.getByRole("button", {name: "Apply and open visual editor"}),
  ).toBeDisabled();

  await dialog.getByRole("button", {name: "Discard YAML draft"}).click();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-editor-mode",
    "visual",
  );
  await expect(
    page.locator(".preview-frame").getByText("Applied from YAML"),
  ).toBeVisible();
});

test("policy-rejected visual candidate transfers explicitly to YAML and exports current buffer", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  await page.getByLabel("Duration (seconds)").fill("301");
  await page.getByRole("button", {name: "Open YAML"}).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "Visual candidate is valid but browser-ineligible",
  );
  await dialog.getByRole("button", {name: "Open candidate in YAML"}).click();

  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-editor-mode",
    "yaml",
  );
  await expect(page.locator("[data-yaml-validation=policy-rejected]")).toBeVisible();
  await expect(page.locator("[data-yaml-dirty=true]")).toBeVisible();

  const source = page.getByLabel("YAML source");
  const transferred = await source.inputValue();
  expect(transferred).toContain("duration: 301");

  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", {name: "Export current YAML candidate"})
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("Deploy-Friday.yaml");

  const downloadedPath = await download.path();
  assertDownloadPath(downloadedPath);
  expect(await readFile(downloadedPath, "utf8")).toBe(transferred);
});

test("eligible visual edits autosave and restore after reload", async ({page}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  await page.getByLabel("Caption").fill("Persist me");

  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("tora-video-engine:project")),
    )
    .toContain("Persist me");

  await page.reload({waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  await expect(page.getByLabel("Caption")).toHaveValue("Persist me");
  await expect(
    page.locator(".preview-frame").getByText("Persist me"),
  ).toBeVisible();
});

test("malformed stored project is protected and fallback edits cannot overwrite it", async ({
  page,
}) => {
  const raw = "{malformed-recovery";

  await page.addInitScript(({raw}) => {
    localStorage.setItem("tora-video-engine:project", raw);
  }, {raw});

  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  await expect(page.getByText("Stored recovery is protected")).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-loss-risk",
    "false",
  );

  await page.getByLabel("Caption").fill("Fallback edit");
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-loss-risk",
    "true",
  );

  expect(
    await page.evaluate(() => localStorage.getItem("tora-video-engine:project")),
  ).toBe(raw);

  const rawDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", {name: "Export stored raw data"}).click();
  const rawDownload = await rawDownloadPromise;
  const rawDownloadPath = await rawDownload.path();
  assertDownloadPath(rawDownloadPath);
  expect(await readFile(rawDownloadPath, "utf8")).toBe(raw);
  expect(
    await page.evaluate(() => localStorage.getItem("tora-video-engine:project")),
  ).toBe(raw);

  await page
    .getByRole("button", {name: "Discard stored project and continue"})
    .click();

  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("tora-video-engine:project")),
    )
    .toContain("Fallback edit");
});

test("oversized import is rejected before File.text", async ({page}) => {
  await page.addInitScript(() => {
    window.__toraFileTextCalls = 0;
    const original = File.prototype.text;

    File.prototype.text = function (...args) {
      window.__toraFileTextCalls += 1;
      return original.apply(this, args);
    };
  });

  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const input = page.locator(".project-toolbar input[type=file]");
  await input.setInputFiles({
    name: "too-large.yaml",
    mimeType: "text/yaml",
    buffer: Buffer.alloc(1_048_577, 0x61),
  });

  await expect(page.getByText(/Import rejected before reading/)).toBeVisible();
  expect(
    await page.evaluate(() => window.__toraFileTextCalls),
  ).toBe(0);
});

test("secondary tab suppresses persistence and retries into conflict after owner closes", async ({
  context,
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const secondary = await context.newPage();
  await secondary.goto("/", {waitUntil: "domcontentloaded"});

  await expect(secondary.locator(".app-shell")).toHaveAttribute(
    "data-persistence-mode",
    "secondary",
    {timeout: 10_000},
  );

  await secondary.getByLabel("Caption").fill("Secondary edit");
  await expect(secondary.locator(".app-shell")).toHaveAttribute(
    "data-loss-risk",
    "true",
  );

  expect(
    await secondary.evaluate(() =>
      localStorage.getItem("tora-video-engine:project"),
    ),
  ).not.toContain("Secondary edit");

  await page.close();

  await secondary
    .getByRole("button", {name: "Retry persistence ownership"})
    .click();

  await expect(secondary.locator(".app-shell")).toHaveAttribute(
    "data-persistence-mode",
    "owner",
    {timeout: 10_000},
  );
  await expect(secondary.getByText("Persistence conflict")).toBeVisible();

  await secondary
    .getByRole("button", {name: "Keep current in memory and overwrite"})
    .click();

  await expect
    .poll(() =>
      secondary.evaluate(() =>
        localStorage.getItem("tora-video-engine:project"),
      ),
    )
    .toContain("Secondary edit");
});


test("persistence write failure keeps the new Story active and loss-risk protected", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("tora-video-engine:project")),
    )
    .not.toBeNull();

  await page.evaluate(() => {
    const storage = window.localStorage;
    const original = storage.setItem.bind(storage);

    Object.defineProperty(storage, "setItem", {
      configurable: true,
      value: (key, value) => {
        if (key === "tora-video-engine:project") {
          throw new DOMException("quota", "QuotaExceededError");
        }

        return original(key, value);
      },
    });
  });

  await page.getByLabel("Caption").fill("Memory-only edit");

  await expect(
    page.locator(".preview-frame").getByText("Memory-only edit"),
  ).toBeVisible();
  await expect(page.getByText(/Autosave failed:/)).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-loss-risk",
    "true",
  );

  expect(
    await page.evaluate(() => localStorage.getItem("tora-video-engine:project")),
  ).not.toContain("Memory-only edit");

  await page.getByRole("button", {name: "Reset project"}).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Reset will discard pending, unpersisted, or recovery state",
  );
  await expect(
    page.getByRole("button", {name: "Export active Story YAML"}).first(),
  ).toBeVisible();
});
