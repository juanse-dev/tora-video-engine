import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, test} from "@playwright/test";
import {buildApng, buildGifSignature} from "../helpers/imageBytes.mjs";
import {
  buildStoryYaml,
  deleteAssetRows,
  fixtureRecord,
  localAssetRef,
  metadataOnlyRecord,
  readFixture,
  solidPngThumbnail,
  syntheticDigest,
} from "./helpers/seedAssetLibrary.mjs";
import {
  applyYaml,
  openSeeded,
  waitForOwner,
} from "./helpers/localAssetPage.mjs";

const ORIGIN = "http://127.0.0.1:4173";
const SYNTHETIC_META = {
  mimeType: "image/png",
  byteSize: 1000,
  width: 10,
  height: 10,
};

const section = (page, category) =>
  page.locator(`[data-my-assets="${category}"]`);
const cards = (page, category) =>
  section(page, category).locator("[data-local-asset-card]");

const syntheticPoses = (count, options = {}) =>
  Array.from({length: count}, (_, index) =>
    metadataOnlyRecord("pose", index + 1, SYNTHETIC_META, options),
  );

const yamlSource = async (page) => {
  await page.getByRole("button", {name: "Open YAML"}).click();

  const source = await page.getByLabel("YAML source").inputValue();

  await page.getByRole("button", {name: "Open visual editor"}).click();

  return source;
};

test("poses and backgrounds each show Bundled and My assets, and bundled cards are unchanged", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});

  await expect(page.getByRole("heading", {name: "Bundled"})).toHaveCount(2);
  await expect(page.getByRole("heading", {name: /^My assets/u})).toHaveCount(2);

  const bundledPoses = page.locator(".pose-grid").first();

  await expect(bundledPoses.locator("button.asset-card")).toHaveCount(4);
  await expect(bundledPoses.getByRole("button", {name: /Formal/u})).toBeVisible();
  await expect(
    page.locator(".background-grid").first().locator("button.asset-card"),
  ).toHaveCount(2);
  // The bundled cards keep their markup: a single button, no wrapper.
  await expect(bundledPoses.locator("div.asset-card")).toHaveCount(0);

  await bundledPoses.getByRole("button", {name: /Panic/u}).click();
  await expect(
    bundledPoses.getByRole("button", {name: /Panic/u}),
  ).toHaveAttribute("aria-pressed", "true");
});

test("My assets shows the local-only disclosure for the page origin and an empty library", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});

  for (const category of ["pose", "background"]) {
    await expect(section(page, category)).toContainText(
      `Stored only in this browser for ${ORIGIN}. Not uploaded or synced. Production, Deploy Previews and localhost each keep a separate library.`,
    );
    await expect(
      section(page, category).getByRole("heading", {name: "My assets · 0"}),
    ).toBeVisible();
    await expect(cards(page, category)).toHaveCount(0);
  }
});

test("seeded rows appear as cards and selecting one applies its ref to the scene", async ({
  page,
}) => {
  const pose = await readFixture("pose-magenta.png");
  const background = await readFixture("background-cyan.jpg");
  const thumbnail = solidPngThumbnail(16, 16, [255, 0, 255]);

  await openSeeded(page, [
    fixtureRecord("pose", pose, {label: "My cat", thumbnail}),
    fixtureRecord("background", background, {label: "Sky"}),
  ]);

  const poseRef = localAssetRef("pose", pose.digest);
  const poseCard = page.locator(`[data-local-asset-card="${poseRef}"]`);

  await expect(
    section(page, "pose").getByRole("heading", {name: "My assets · 1"}),
  ).toBeVisible();
  await expect(cards(page, "pose")).toHaveCount(1);
  await expect(cards(page, "background")).toHaveCount(1);
  await expect(poseCard).toContainText("My cat");
  await expect(poseCard).toContainText("Local");

  // Thumbnail: a verified blob: URL that really decodes.
  const image = poseCard.locator("img");

  await expect(image).toHaveAttribute("src", /^blob:/u);
  await expect
    .poll(() => image.evaluate((element) => element.naturalWidth))
    .toBeGreaterThan(0);
  // The card without a stored thumbnail falls back to a neutral box.
  await expect(
    cards(page, "background").first().locator("img"),
  ).toHaveCount(0);

  const select = poseCard.locator("button[aria-pressed]");

  await expect(select).toHaveAttribute("aria-pressed", "false");
  await select.click();
  await expect(select).toHaveAttribute("aria-pressed", "true");
  await expect(poseCard).toContainText("Current");
  expect(await yamlSource(page)).toContain(`pose: ${poseRef}`);

  const backgroundRef = localAssetRef("background", background.digest);

  await page
    .locator(`[data-local-asset-card="${backgroundRef}"]`)
    .locator("button[aria-pressed]")
    .click();
  expect(await yamlSource(page)).toContain(`background: ${backgroundRef}`);
  expect(await yamlSource(page)).toContain(`pose: ${poseRef}`);
});

test("local cards nest no interactive element inside another and management buttons do not select", async ({
  page,
}) => {
  const pose = await readFixture("pose-magenta.png");

  await openSeeded(page, [fixtureRecord("pose", pose, {label: "My cat"})]);

  const card = cards(page, "pose").first();

  await expect(card).toBeVisible();
  expect(await card.evaluate((element) => element.tagName)).toBe("DIV");
  await expect(
    card.locator(
      "button button, button input, button select, button textarea, button a, a button",
    ),
  ).toHaveCount(0);
  await expect(card.locator("button[aria-pressed]")).toHaveCount(1);
  // Management buttons name their asset.
  await expect(
    card.getByRole("button", {name: "Rename My cat", exact: true}),
  ).toHaveCount(1);
  await expect(
    card.getByRole("button", {name: "Delete My cat", exact: true}),
  ).toHaveCount(1);
  // Rename and Delete are not descendants of the selection button.
  await expect(
    card.locator("button[aria-pressed] button"),
  ).toHaveCount(0);
  await expect(card.locator("button[aria-pressed]")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("a Story ref that is not on the visible page is pinned first as the Current card", async ({
  page,
}) => {
  const pose = await readFixture("pose-magenta.png");

  // 120 synthetic rows sort before the real digest, so the fixture is on page 3.
  await openSeeded(page, [
    ...syntheticPoses(120),
    fixtureRecord("pose", pose, {label: "Pinned cat"}),
  ]);
  await expect(cards(page, "pose")).toHaveCount(50);
  await applyYaml(
    page,
    buildStoryYaml([
      {pose: localAssetRef("pose", pose.digest), background: "office"},
    ]),
  );
  await page.getByRole("button", {name: "Open visual editor"}).click();

  const grid = section(page, "pose").locator(".my-assets-grid");

  await expect(grid.locator("[data-local-asset-card]").first()).toContainText(
    "Pinned cat",
  );
  await expect(grid.locator("[data-local-asset-card]").first()).toContainText(
    "Current",
  );
  // 1 pinned card + the 50-row page.
  await expect(grid.locator("[data-local-asset-card]")).toHaveCount(51);
});

test("a missing local ref shows a placeholder as the current card", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});

  const missing = localAssetRef("pose", syntheticDigest(0xabcdef));

  await applyYaml(
    page,
    buildStoryYaml([{pose: missing, background: "office"}]),
  );
  await page.getByRole("button", {name: "Open visual editor"}).click();

  const placeholder = page.locator(`[data-local-asset-placeholder="${missing}"]`);

  await expect(
    page.getByRole("group", {name: /^Missing local pose [0-9a-f]{4}…[0-9a-f]{4}$/u}),
  ).toHaveCount(1);

  await expect(placeholder).toContainText("Missing local pose");
  await expect(placeholder).toContainText("Used by scene 1.");
});

test("120 seeded poses: pages of 50, a total of 120, and no blob or getAll reads", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls = [];
    const record = (store, method) => calls.push(`${store}:${method}`);

    for (const method of [
      "get",
      "getAll",
      "getAllKeys",
      "openCursor",
      "openKeyCursor",
      "count",
    ]) {
      const native = IDBObjectStore.prototype[method];

      IDBObjectStore.prototype[method] = function (...args) {
        record(this.name, method);

        return native.apply(this, args);
      };
    }

    const nativeObjectStore = IDBTransaction.prototype.objectStore;

    IDBTransaction.prototype.objectStore = function (name) {
      record(name, "objectStore");

      return nativeObjectStore.call(this, name);
    };
    window.__idbCalls = calls;
  });

  await openSeeded(page, syntheticPoses(120));

  const pose = section(page, "pose");

  await expect(
    pose.getByRole("heading", {name: "My assets · 120"}),
  ).toBeVisible();
  await expect(cards(page, "pose")).toHaveCount(50);
  await expect(cards(page, "pose").first()).toContainText("Synthetic 1");
  await expect(cards(page, "pose").last()).toContainText("Synthetic 50");
  await expect(pose.getByRole("button", {name: /Previous/u})).toBeDisabled();

  await pose.getByRole("button", {name: /Next/u}).click();
  await expect(cards(page, "pose").first()).toContainText("Synthetic 51");
  await expect(cards(page, "pose")).toHaveCount(50);
  await expect(pose.getByRole("button", {name: /Previous/u})).toBeEnabled();

  await pose.getByRole("button", {name: /Next/u}).click();
  await expect(cards(page, "pose").first()).toContainText("Synthetic 101");
  await expect(cards(page, "pose")).toHaveCount(20);
  await expect(pose.getByRole("button", {name: /Next/u})).toBeDisabled();

  await pose.getByRole("button", {name: /Previous/u}).click();
  await pose.getByRole("button", {name: /Previous/u}).click();
  await expect(cards(page, "pose").first()).toContainText("Synthetic 1");
  await expect(pose.getByRole("button", {name: /Previous/u})).toBeDisabled();

  const calls = await page.evaluate(() => window.__idbCalls);

  // Positive control: the instrumentation saw the listing.
  expect(calls).toContain("assets:openCursor");
  expect(calls.filter((call) => call.startsWith("blobs:"))).toEqual([]);
  expect(calls).not.toContain("assets:getAll");
  expect(calls).not.toContain("assets:getAllKeys");
});

test("thumbnail object URLs exist for the visible page only and are revoked when it changes", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const created = [];
    const nativeCreate = URL.createObjectURL.bind(URL);

    URL.createObjectURL = (blob) => {
      const url = nativeCreate(blob);

      created.push(url);

      return url;
    };
    window.__createdObjectUrls = created;
  });

  const thumbnail = solidPngThumbnail(8, 8, [0, 255, 0]);

  await openSeeded(page, syntheticPoses(60, {thumbnail}));

  const pose = section(page, "pose");
  const images = pose.locator("[data-local-asset-card] img");

  await expect(cards(page, "pose")).toHaveCount(50);
  await expect(images).toHaveCount(50);

  const firstPageUrls = await images.evaluateAll((elements) =>
    elements.map((element) => element.src),
  );

  expect(firstPageUrls.every((url) => url.startsWith("blob:"))).toBe(true);

  await pose.getByRole("button", {name: /Next/u}).click();
  await expect(cards(page, "pose")).toHaveCount(10);
  await expect(images).toHaveCount(10);

  // The previous page's thumbnails are revoked: fetching them fails.
  const readable = (urls) =>
    page.evaluate(
      async (list) =>
        Promise.all(
          list.map((url) =>
            fetch(url).then(
              () => true,
              () => false,
            ),
          ),
        ),
      urls,
    );
  const secondPageUrls = await images.evaluateAll((elements) =>
    elements.map((element) => element.src),
  );

  // Positive control: the visible page's URLs are readable ...
  expect((await readable(secondPageUrls)).every(Boolean)).toBe(true);
  // ... and the previous page's are revoked.
  expect((await readable(firstPageUrls)).some(Boolean)).toBe(false);
});

test("without Web Locks My assets shows the disabled message, no import controls, and the bundled flow works", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto("/", {waitUntil: "domcontentloaded"});

  for (const category of ["pose", "background"]) {
    await expect(section(page, category)).toContainText(
      "My assets needs a browser with Web Locks support.",
    );
    await expect(section(page, category).getByRole("heading")).toHaveText(
      "My assets",
    );
    await expect(section(page, category).getByRole("button")).toHaveCount(0);
    await expect(section(page, category).locator("input")).toHaveCount(0);
  }

  await expect(page.getByText(/Import pose|Import background/u)).toHaveCount(0);

  const bundledPoses = page.locator(".pose-grid").first();

  await bundledPoses.getByRole("button", {name: /Coffee/u}).click();
  await expect(
    bundledPoses.getByRole("button", {name: /Coffee/u}),
  ).toHaveAttribute("aria-pressed", "true");
});

// --- Import, rename and delete flows (ASSET-003 task 3) -----------------------

const fixtureUpload = (fixture) => ({
  name: fixture.name,
  mimeType: fixture.meta.mimeType,
  buffer: Buffer.from(fixture.bytes),
});
const importInput = (page, category) =>
  section(page, category).locator('input[type="file"]');
const statusLine = (page, category) =>
  section(page, category).getByRole("status");
const alertLine = (page, category) =>
  section(page, category).getByRole("alert");
const cardFor = (page, category, digest) =>
  page.locator(`[data-local-asset-card="${localAssetRef(category, digest)}"]`);
const blobImages = (page) => page.locator(".preview-frame img[src^='blob:']");

/** Holds crypto.subtle.digest (the import's hashing phase) until released. */
const holdDigests = (page) =>
  page.addInitScript(() => {
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    window.__holdDigest = false;
    window.__heldDigests = 0;
    window.__releaseDigest = () => {
      window.__holdDigest = false;
      release();
    };
    crypto.subtle.digest = async (...args) => {
      if (window.__holdDigest) {
        window.__heldDigests += 1;
        await gate;
      }

      return nativeDigest(...args);
    };
  });
const startHeldImport = async (page, category, fixture) => {
  await page.evaluate(() => {
    window.__holdDigest = true;
  });
  await importInput(page, category).setInputFiles(fixtureUpload(fixture));
  await expect
    .poll(() => page.evaluate(() => window.__heldDigests))
    .toBeGreaterThan(0);
};

test("importing the pose fixture applies it: Current card, YAML ref and the Player image", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const pose = await readFixture("pose-magenta.png");
  const ref = localAssetRef("pose", pose.digest);

  await expect(importInput(page, "pose")).toBeEnabled();
  await importInput(page, "pose").setInputFiles(fixtureUpload(pose));

  await expect(statusLine(page, "pose")).toHaveText('Imported "pose-magenta".');
  await expect(
    section(page, "pose").getByRole("heading", {name: "My assets · 1"}),
  ).toBeVisible();
  await expect(cards(page, "pose")).toHaveCount(1);
  await expect(cards(page, "pose").first()).toHaveAttribute(
    "data-local-asset-card",
    ref,
  );
  await expect(cards(page, "pose").first()).toContainText("Current");
  await expect(
    cards(page, "pose").first().locator("button[aria-pressed]"),
  ).toHaveAttribute("aria-pressed", "true");
  expect(await yamlSource(page)).toContain(`pose: ${ref}`);
  await expect(blobImages(page)).toHaveCount(1);
  await expect(page.locator("[data-missing-local-asset]")).toHaveCount(0);
  // The import ended: authoring is unlocked again.
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-authoring-locked",
    "false",
  );
});

test("the extensionless background fixture is accepted", async ({page}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const background = await readFixture("background-noext");
  const ref = localAssetRef("background", background.digest);

  await importInput(page, "background").setInputFiles(
    fixtureUpload(background),
  );
  await expect(statusLine(page, "background")).toHaveText(
    'Imported "background-noext".',
  );
  await expect(cards(page, "background")).toHaveCount(1);
  expect(await yamlSource(page)).toContain(`background: ${ref}`);
});

test("an APNG, a file over 25 MiB and a GIF are each refused with a message and change nothing", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "tora-import-"));

  try {
    const apng = join(directory, "animated.png");
    const huge = join(directory, "huge.png");
    const gif = join(directory, "picture.gif");

    await writeFile(apng, buildApng({width: 4, height: 4}));
    await writeFile(huge, Buffer.alloc(25 * 1024 * 1024 + 1));
    await writeFile(gif, buildGifSignature());

    await page.goto("/", {waitUntil: "domcontentloaded"});
    await waitForOwner(page);

    const before = await yamlSource(page);

    for (const [file, message] of [
      [apng, "Animated images are not supported."],
      [huge, "The file is larger than 25 MiB."],
      [gif, "Only static PNG, JPEG and WebP images are supported."],
    ]) {
      await importInput(page, "pose").setInputFiles(file);
      await expect(alertLine(page, "pose")).toHaveText(message);
      await expect(cards(page, "pose")).toHaveCount(0);
      await expect(
        section(page, "pose").getByRole("heading", {name: "My assets · 0"}),
      ).toBeVisible();
      expect(await yamlSource(page)).toBe(before);
      await expect(page.locator(".app-shell")).toHaveAttribute(
        "data-authoring-locked",
        "false",
      );
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test("importing the same file again says it was already in My assets and keeps one card", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const pose = await readFixture("pose-magenta.png");

  await importInput(page, "pose").setInputFiles(fixtureUpload(pose));
  await expect(statusLine(page, "pose")).toHaveText('Imported "pose-magenta".');
  await importInput(page, "pose").setInputFiles(fixtureUpload(pose));
  await expect(statusLine(page, "pose")).toHaveText(
    '"pose-magenta" was already in My assets; its stored copy was refreshed.',
  );
  await expect(cards(page, "pose")).toHaveCount(1);
  await expect(
    section(page, "pose").getByRole("heading", {name: "My assets · 1"}),
  ).toBeVisible();
});

test("rename changes the label (Enter, Save, Cancel, Escape, invalid) and never the Story", async ({
  page,
}) => {
  const pose = await readFixture("pose-magenta.png");

  await openSeeded(page, [fixtureRecord("pose", pose, {label: "My cat"})]);

  const card = cardFor(page, "pose", pose.digest);
  const before = await yamlSource(page);
  const input = card.getByRole("textbox");
  const renameButton = (name) =>
    card.getByRole("button", {name: `Rename ${name}`, exact: true});

  // Cancel and Escape keep the label.
  await renameButton("My cat").click();
  await expect(input).toBeFocused();
  await expect(card.locator("button[aria-pressed]")).toHaveCount(0);
  await input.fill("Discarded");
  await card.getByRole("button", {name: "Cancel"}).click();
  await expect(input).toHaveCount(0);
  await expect(card).toContainText("My cat");

  await renameButton("My cat").click();
  await input.fill("Also discarded");
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(card).toContainText("My cat");

  // An invalid label shows the validation message and stays in edit mode.
  await renameButton("My cat").click();
  await input.fill("   ");
  await input.press("Enter");
  await expect(card.getByRole("alert")).toHaveText(
    "Enter a name for this asset.",
  );
  await input.fill("x".repeat(81));
  await card.getByRole("button", {name: "Save"}).click();
  await expect(card.getByRole("alert")).toHaveText(
    "Names can be at most 80 characters.",
  );
  await expect(input).toBeVisible();

  // Enter saves.
  await input.fill("  Best cat  ");
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  await expect(card).toContainText("Best cat");
  await expect(card.locator("button[aria-pressed]")).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  // Save saves.
  await renameButton("Best cat").click();
  await input.fill("Final cat");
  await card.getByRole("button", {name: "Save"}).click();
  await expect(card).toContainText("Final cat");

  expect(await yamlSource(page)).toBe(before);

  // The new label is stored, not just shown.
  await page.reload({waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await expect(cardFor(page, "pose", pose.digest)).toContainText("Final cat");
});

test("renaming an asset that another tab deleted says so and refreshes the list", async ({
  page,
}) => {
  const pose = await readFixture("pose-magenta.png");

  await openSeeded(page, [fixtureRecord("pose", pose, {label: "My cat"})]);

  const card = cardFor(page, "pose", pose.digest);

  await card.getByRole("button", {name: "Rename My cat", exact: true}).click();
  await deleteAssetRows(page, [localAssetRef("pose", pose.digest)]);
  await card.getByRole("textbox").fill("Too late");
  await card.getByRole("button", {name: "Save"}).click();

  await expect(alertLine(page, "pose")).toHaveText(
    "This asset was deleted in another tab.",
  );
  await expect(cards(page, "pose")).toHaveCount(0);
  await expect(
    section(page, "pose").getByRole("heading", {name: "My assets · 0"}),
  ).toBeVisible();
});

test("clicking Rename or Delete never changes the selected scene's ref", async ({
  page,
}) => {
  const pose = await readFixture("pose-magenta.png");

  await openSeeded(page, [fixtureRecord("pose", pose, {label: "My cat"})]);

  const card = cardFor(page, "pose", pose.digest);
  const before = await yamlSource(page);

  await card.getByRole("button", {name: "Rename My cat", exact: true}).click();
  await expect(card.getByRole("textbox")).toBeVisible();
  await card.getByRole("button", {name: "Cancel"}).click();
  await card.getByRole("button", {name: "Delete My cat", exact: true}).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", {name: "Cancel"}).click();

  expect(await yamlSource(page)).toBe(before);
  await expect(card.locator("button[aria-pressed]")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(card).toContainText("My cat");
});

test("deleting an unused asset asks first and then removes its card", async ({
  page,
}) => {
  const pose = await readFixture("pose-magenta.png");

  await openSeeded(page, [fixtureRecord("pose", pose, {label: "My cat"})]);

  const dialog = page.getByRole("dialog");

  await cardFor(page, "pose", pose.digest)
    .getByRole("button", {name: "Delete My cat", exact: true})
    .click();
  await expect(dialog).toContainText('Delete "My cat" (pose) from My assets?');
  await expect(dialog.getByRole("button")).toHaveText([
    "Cancel",
    "Delete asset",
  ]);
  await dialog.getByRole("button", {name: "Delete asset", exact: true}).click();

  await expect(dialog).toHaveCount(0);
  await expect(cards(page, "pose")).toHaveCount(0);
  await expect(
    section(page, "pose").getByRole("heading", {name: "My assets · 0"}),
  ).toBeVisible();
  await page.reload({waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await expect(cards(page, "pose")).toHaveCount(0);
});

test("deleting an in-use asset warns with the scene count and leaves the Story with a missing asset", async ({
  page,
}) => {
  const pose = await readFixture("pose-magenta.png");
  const ref = localAssetRef("pose", pose.digest);

  await openSeeded(page, [fixtureRecord("pose", pose, {label: "My cat"})]);
  await applyYaml(
    page,
    buildStoryYaml([
      {pose: ref, background: "office"},
      {pose: "formal", background: "office"},
      {pose: ref, background: "server-room"},
    ]),
  );
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await expect(blobImages(page)).toHaveCount(1);

  const dialog = page.getByRole("dialog");
  const deleteButton = cardFor(page, "pose", pose.digest).getByRole("button", {
    name: "Delete My cat",
    exact: true,
  });
  const yamlBefore = await yamlSource(page);

  await deleteButton.click();
  await expect(dialog).toContainText(
    '"My cat" (pose) is used by 2 scenes in this Story. Deleting it leaves those scenes with a missing local asset, and MP4 rendering stays blocked until you re-import the same file or choose a replacement. Other exported YAML files may also use it.',
  );
  await expect(dialog.getByRole("button")).toHaveText([
    "Cancel",
    "Delete asset anyway",
  ]);

  // Cancel keeps everything.
  await dialog.getByRole("button", {name: "Cancel"}).click();
  await expect(dialog).toHaveCount(0);
  await expect(cardFor(page, "pose", pose.digest)).toBeVisible();
  await expect(blobImages(page)).toHaveCount(1);
  expect(await yamlSource(page)).toBe(yamlBefore);

  // Confirming deletes the asset, never the Story's reference.
  await deleteButton.click();
  await dialog.getByRole("button", {name: "Delete asset anyway"}).click();
  await expect(dialog).toHaveCount(0);
  await expect(cardFor(page, "pose", pose.digest)).toHaveCount(0);
  await expect(
    page.locator(`[data-local-asset-placeholder="${ref}"]`),
  ).toContainText("Missing local pose");
  await expect(page.locator("[data-missing-local-asset]")).toHaveCount(1);
  await expect(blobImages(page)).toHaveCount(0);
  await expect(page.getByRole("button", {name: "Render MP4"})).toBeDisabled();
  await expect(page.locator(".render-banner")).toHaveAttribute(
    "data-local-asset-block",
    /local asset\(s\) are unavailable/u,
  );
  expect(await yamlSource(page)).toBe(yamlBefore);
});

test("the delete dialog is labelled, focuses Cancel and closes on Escape without deleting", async ({
  page,
}) => {
  const pose = await readFixture("pose-magenta.png");

  await openSeeded(page, [fixtureRecord("pose", pose, {label: "My cat"})]);

  const deleteButton = cardFor(page, "pose", pose.digest).getByRole("button", {
    name: "Delete My cat",
    exact: true,
  });

  await deleteButton.click();

  const dialog = page.getByRole("dialog", {
    name: 'Delete "My cat" (pose) from My assets?',
  });

  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", {name: "Cancel"})).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(cardFor(page, "pose", pose.digest)).toBeVisible();
  // Focus returns to the button that opened the dialog.
  await expect(deleteButton).toBeFocused();
});

const twoSceneStory = () =>
  buildStoryYaml([
    {pose: "formal", background: "office"},
    {pose: "formal", background: "server-room"},
  ]);

/** Scene add/move/delete/select, Open YAML, Reset and Render must all be disabled. */
const expectAuthoringLocked = async (page) => {
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-authoring-locked",
    "true",
  );
  await expect(page.getByRole("button", {name: "Add scene"})).toBeDisabled();
  await expect(
    page.getByRole("button", {name: "Move scene up"}),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {name: "Move scene down"}),
  ).toBeDisabled();
  await expect(
    page
      .locator(".scene-form-toolbar")
      .getByRole("button", {name: "Delete", exact: true}),
  ).toBeDisabled();

  for (const item of await page.locator(".scene-list-item").all()) {
    await expect(item).toBeDisabled();
  }

  await expect(page.getByRole("button", {name: "Open YAML"})).toBeDisabled();
  await expect(
    page.getByRole("button", {name: "Reset project"}),
  ).toBeDisabled();
  await expect(page.getByRole("button", {name: "Render MP4"})).toBeDisabled();
};

test("during an import authoring is locked, and the ref lands on the scene selected when it started", async ({
  page,
}) => {
  await holdDigests(page);
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await applyYaml(page, twoSceneStory());
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await page.locator(".scene-list-item").nth(1).click();

  const pose = await readFixture("pose-magenta.png");

  await startHeldImport(page, "pose", pose);
  await expect(statusLine(page, "pose")).toHaveText("Hashing…");
  await expectAuthoringLocked(page);
  await expect(importInput(page, "pose")).toBeDisabled();
  await expect(importInput(page, "background")).toBeDisabled();

  await page.evaluate(() => window.__releaseDigest());
  await expect(statusLine(page, "pose")).toHaveText('Imported "pose-magenta".');
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-authoring-locked",
    "false",
  );

  // Scene 2 (selected when the import started) has the ref; scene 1 does not.
  const select = cardFor(page, "pose", pose.digest).locator(
    "button[aria-pressed]",
  );

  await expect(select).toHaveAttribute("aria-pressed", "true");
  await page.locator(".scene-list-item").nth(0).click();
  await expect(select).toHaveAttribute("aria-pressed", "false");
  await page.locator(".scene-list-item").nth(1).click();
  await expect(select).toHaveAttribute("aria-pressed", "true");
});

test("while the delete dialog is open the Story is frozen and the dialog still works", async ({
  page,
}) => {
  const pose = await readFixture("pose-magenta.png");

  await openSeeded(page, [fixtureRecord("pose", pose, {label: "My cat"})]);
  await applyYaml(page, twoSceneStory());
  await page.getByRole("button", {name: "Open visual editor"}).click();

  const dialog = page.getByRole("dialog");
  const open = () =>
    cardFor(page, "pose", pose.digest)
      .getByRole("button", {name: "Delete My cat", exact: true})
      .click();

  await open();
  await expect(dialog).toBeVisible();
  await expectAuthoringLocked(page);
  await expect(importInput(page, "pose")).toBeDisabled();
  await expect(dialog.getByRole("button", {name: "Cancel"})).toBeEnabled();
  await expect(
    dialog.getByRole("button", {name: "Delete asset", exact: true}),
  ).toBeEnabled();

  await dialog.getByRole("button", {name: "Cancel"}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", {name: "Add scene"})).toBeEnabled();
  await expect(importInput(page, "pose")).toBeEnabled();

  await open();
  await dialog.getByRole("button", {name: "Delete asset", exact: true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(cards(page, "pose")).toHaveCount(0);
  await expect(page.getByRole("button", {name: "Add scene"})).toBeEnabled();
});

test("with a transition panel open the import buttons are disabled, and during an import its confirmations are", async ({
  page,
}) => {
  await holdDigests(page);
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  // An invalid draft makes "Open YAML" ask before leaving the visual editor.
  await page.getByLabel("Caption").fill("");
  await page.getByRole("button", {name: "Open YAML"}).click();

  const panel = page.getByRole("dialog");

  await expect(panel).toContainText("Visual draft is invalid.");
  await expect(importInput(page, "pose")).toBeDisabled();
  await expect(importInput(page, "background")).toBeDisabled();
  await panel.getByRole("button", {name: "Stay in visual editor"}).click();
  await expect(panel).toHaveCount(0);
  await expect(importInput(page, "pose")).toBeEnabled();

  // The defensive direction. A transition cannot normally open during an
  // import (Open YAML is disabled), so call the button's React onClick directly,
  // bypassing the disabled check, and verify the panel's confirmations hold.
  const pose = await readFixture("pose-magenta.png");

  await startHeldImport(page, "pose", pose);
  await expect(page.getByRole("button", {name: "Open YAML"})).toBeDisabled();
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Open YAML",
    );
    const propsKey = Object.keys(button).find((key) =>
      key.startsWith("__reactProps$"),
    );

    button[propsKey].onClick();
  });
  await expect(panel).toContainText("Visual draft is invalid.");
  await expect(
    panel.getByRole("button", {name: "Discard visual draft"}),
  ).toBeDisabled();
  await page.evaluate(() => window.__releaseDigest());
  await expect(statusLine(page, "pose")).toHaveText('Imported "pose-magenta".');
});

test("a failing delete keeps the asset and the dialog, shows why, and Cancel still closes it", async ({
  page,
}) => {
  const pose = await readFixture("pose-magenta.png");

  await openSeeded(page, [fixtureRecord("pose", pose, {label: "My cat"})]);

  const dialog = page.getByRole("dialog");

  await cardFor(page, "pose", pose.digest)
    .getByRole("button", {name: "Delete My cat", exact: true})
    .click();
  await expect(dialog).toBeVisible();
  // Every library mutation takes the exclusive Web Lock, so this makes it fail.
  await page.evaluate(() => {
    navigator.locks.request = () => Promise.reject(new Error("lock refused"));
  });
  await dialog.getByRole("button", {name: "Delete asset", exact: true}).click();

  await expect(dialog.getByRole("alert")).toHaveText(
    "That didn't work: The asset could not be deleted.",
  );
  await expect(dialog.getByRole("button", {name: "Cancel"})).toBeEnabled();
  await expect(cardFor(page, "pose", pose.digest)).toBeVisible();
  await dialog.getByRole("button", {name: "Cancel"}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-authoring-locked",
    "false",
  );
});
