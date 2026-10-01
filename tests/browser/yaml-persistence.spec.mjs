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

  await expect(
    page.locator(".recovery-banner strong").getByText(
      "Stored recovery is protected",
      {exact: true},
    ),
  ).toBeVisible();
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
    const original = Storage.prototype.setItem;

    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value(key, value) {
        if (
          this === window.localStorage &&
          key === "tora-video-engine:project"
        ) {
          throw new DOMException("quota", "QuotaExceededError");
        }

        return original.call(this, key, value);
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


test("import rechecks live editor state after asynchronous File.text", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = File.prototype.text;

    File.prototype.text = function (...args) {
      return new Promise((resolve, reject) => {
        window.__releaseImportRead = () => {
          original.apply(this, args).then(resolve, reject);
        };
      });
    };
  });

  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const input = page.locator(".project-toolbar input[type=file]");
  await input.setInputFiles({
    name: "import.yaml",
    mimeType: "text/yaml",
    buffer: Buffer.from(
      [
        "title: Imported",
        "scenes:",
        "  - type: intro",
        "    pose: formal",
        "    background: office",
        "    text: Imported caption",
        "    duration: 1",
        "",
      ].join("\n"),
    ),
  });

  await page.getByLabel("Caption").fill("");
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-visual-state",
    "schema-invalid",
  );

  await page.evaluate(() => window.__releaseImportRead());

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "Import will discard current pending or recovery work",
  );
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-visual-state",
    "schema-invalid",
  );
  await expect(
    page.locator(".preview-frame").getByText("Tora tiene una regla."),
  ).toBeVisible();

  await dialog.getByRole("button", {name: "Cancel import"}).click();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-visual-state",
    "schema-invalid",
  );
});

test("retry ownership clears stale local recovery after another owner replaces it", async ({
  context,
  page,
}) => {
  const raw = "{stale-recovery";

  await page.addInitScript(({raw}) => {
    localStorage.setItem("tora-video-engine:project", raw);
  }, {raw});

  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await expect(page.locator(".recovery-banner")).toBeVisible();

  const secondary = await context.newPage();
  await secondary.goto("/", {waitUntil: "domcontentloaded"});
  await expect(secondary.locator(".app-shell")).toHaveAttribute(
    "data-persistence-mode",
    "secondary",
    {timeout: 10_000},
  );
  await expect(secondary.locator(".recovery-banner")).toBeVisible();

  await page
    .getByRole("button", {name: "Discard stored project and continue"})
    .click();

  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("tora-video-engine:project"),
      ),
    )
    .not.toBe(raw);

  await page.close();

  await secondary
    .getByRole("button", {name: "Retry persistence ownership"})
    .click();

  await expect(secondary.locator(".app-shell")).toHaveAttribute(
    "data-persistence-mode",
    "owner",
    {timeout: 10_000},
  );
  await expect(secondary.locator(".recovery-banner")).toHaveCount(0);
});

test("secondary tab does not claim its unchanged initial snapshot is durable", async ({
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
  await expect(secondary.locator(".app-shell")).toHaveAttribute(
    "data-loss-risk",
    "true",
  );
});


test("policy-rejected import stays non-active and exports the original source verbatim", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const source = [
    "title: CLI Candidate",
    "scenes:",
    "  - type: intro",
    "    pose: formal",
    "    background: office",
    "    text: Keep active preview",
    "    duration: 301",
    "",
    "# preserve this exact comment",
    "",
  ].join("\n");

  await page.locator(".project-toolbar input[type=file]").setInputFiles({
    name: "cli-candidate.yaml",
    mimeType: "text/yaml",
    buffer: Buffer.from(source),
  });

  const candidateBanner = page.locator(
    '[data-import-candidate="policy-rejected"]',
  );
  await expect(candidateBanner).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-loss-risk",
    "true",
  );
  await expect(
    page.locator(".preview-frame").getByText("Tora tiene una regla."),
  ).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await candidateBanner
    .getByRole("button", {name: "Export imported YAML candidate"})
    .click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  assertDownloadPath(downloadedPath);
  expect(await readFile(downloadedPath, "utf8")).toBe(source);
});

test("canceling an eligible import preserves the previously retained policy-rejected candidate", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const retainedSource = [
    "title: Retained CLI Candidate",
    "scenes:",
    "  - type: intro",
    "    pose: formal",
    "    background: office",
    "    text: Keep this candidate",
    "    duration: 301",
    "",
    "# retained verbatim",
    "",
  ].join("\n");

  const input = page.locator(".project-toolbar input[type=file]");
  await input.setInputFiles({
    name: "retained.yaml",
    mimeType: "text/yaml",
    buffer: Buffer.from(retainedSource),
  });

  const candidateBanner = page.locator(
    '[data-import-candidate="policy-rejected"]',
  );
  await expect(candidateBanner).toBeVisible();

  const eligibleSource = [
    "title: Eligible replacement",
    "scenes:",
    "  - type: intro",
    "    pose: formal",
    "    background: office",
    "    text: Eligible replacement",
    "    duration: 1",
    "",
  ].join("\n");

  await input.setInputFiles({
    name: "eligible.yaml",
    mimeType: "text/yaml",
    buffer: Buffer.from(eligibleSource),
  });

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "Import will discard current pending or recovery work",
  );
  await dialog.getByRole("button", {name: "Cancel import"}).click();

  await expect(candidateBanner).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await candidateBanner
    .getByRole("button", {name: "Export imported YAML candidate"})
    .click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  assertDownloadPath(downloadedPath);
  expect(await readFile(downloadedPath, "utf8")).toBe(retainedSource);
});

test("a newer rejected import invalidates an older staged import", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  await page.getByLabel("Caption").fill("");
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-visual-state",
    "schema-invalid",
  );

  const input = page.locator(".project-toolbar input[type=file]");
  const eligibleSource = [
    "title: Staged import",
    "scenes:",
    "  - type: intro",
    "    pose: formal",
    "    background: office",
    "    text: Must never commit",
    "    duration: 1",
    "",
  ].join("\n");

  await input.setInputFiles({
    name: "staged.yaml",
    mimeType: "text/yaml",
    buffer: Buffer.from(eligibleSource),
  });

  await expect(page.getByRole("dialog")).toContainText(
    "Import will discard current pending or recovery work",
  );

  await input.setInputFiles({
    name: "too-large.yaml",
    mimeType: "text/yaml",
    buffer: Buffer.alloc(1_048_577, 0x61),
  });

  await expect(page.getByText(/Import rejected before reading/)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.locator(".preview-frame").getByText("Must never commit"),
  ).toHaveCount(0);
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-visual-state",
    "schema-invalid",
  );
});

test("deleted durable slot becomes a conflict and confirmed reset clears it", async ({
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

  await page.evaluate(() => {
    localStorage.removeItem("tora-video-engine:project");
  });
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
  expect(
    await secondary.evaluate(() =>
      localStorage.getItem("tora-video-engine:project"),
    ),
  ).toBeNull();

  await secondary.getByRole("button", {name: "Reset project"}).click();
  const dialog = secondary.getByRole("dialog");
  await dialog
    .getByRole("button", {name: "Discard current state and reset"})
    .click();

  await expect(secondary.getByText("Persistence conflict")).toHaveCount(0);
  await expect
    .poll(() =>
      secondary.evaluate(() =>
        localStorage.getItem("tora-video-engine:project"),
      ),
    )
    .not.toBeNull();
});

test("recovery replacing a previously durable Story keeps unload loss-risk active", async ({
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

  await page.evaluate(() => {
    localStorage.setItem(
      "tora-video-engine:project",
      "{replacement-recovery",
    );
  });
  await page.close();

  await secondary
    .getByRole("button", {name: "Retry persistence ownership"})
    .click();

  await expect(secondary.locator(".app-shell")).toHaveAttribute(
    "data-persistence-mode",
    "owner",
    {timeout: 10_000},
  );
  await expect(secondary.locator(".recovery-banner")).toBeVisible();
  await expect(secondary.locator(".app-shell")).toHaveAttribute(
    "data-loss-risk",
    "true",
  );
});

test("autosave failure warning clears when active Story returns to durable state", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("tora-video-engine:project"),
      ),
    )
    .not.toBeNull();

  await page.evaluate(() => {
    const original = Storage.prototype.setItem;

    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value(key, value) {
        if (
          this === window.localStorage &&
          key === "tora-video-engine:project"
        ) {
          throw new DOMException("quota", "QuotaExceededError");
        }

        return original.call(this, key, value);
      },
    });
  });

  const caption = page.getByLabel("Caption");
  await caption.fill("Temporary memory-only edit");
  await expect(page.getByText(/Autosave failed:/)).toBeVisible();

  await caption.fill("Tora tiene una regla.");

  await expect(page.getByText(/Autosave failed:/)).toHaveCount(0);
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-loss-risk",
    "false",
  );
});

test("confirmed eligible import clears an existing persistence conflict", async ({
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

  await page.getByLabel("Caption").fill("Owner changed durable");
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("tora-video-engine:project"),
      ),
    )
    .toContain("Owner changed durable");
  await page.close();

  await secondary
    .getByRole("button", {name: "Retry persistence ownership"})
    .click();
  await expect(secondary.getByText("Persistence conflict")).toBeVisible();

  const source = [
    "title: Imported after conflict",
    "scenes:",
    "  - type: intro",
    "    pose: formal",
    "    background: office",
    "    text: Imported after conflict",
    "    duration: 1",
    "",
  ].join("\n");

  await secondary
    .locator(".project-toolbar input[type=file]")
    .setInputFiles({
      name: "conflict-import.yaml",
      mimeType: "text/yaml",
      buffer: Buffer.from(source),
    });

  const dialog = secondary.locator(".transition-panel");
  await expect(dialog).toContainText(
    "Import will discard current pending or recovery work",
  );
  await dialog
    .getByRole("button", {name: "Discard current work and import"})
    .click();

  await expect(secondary.getByText("Persistence conflict")).toHaveCount(0);
  await expect(
    secondary.locator(".preview-frame").getByText("Imported after conflict"),
  ).toBeVisible();
  await expect
    .poll(() =>
      secondary.evaluate(() =>
        localStorage.getItem("tora-video-engine:project"),
      ),
    )
    .toContain("Imported after conflict");
});
