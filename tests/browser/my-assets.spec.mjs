import {expect, test} from "@playwright/test";
import {
  buildStoryYaml,
  fixtureRecord,
  localAssetRef,
  metadataOnlyRecord,
  readFixture,
  solidPngThumbnail,
  syntheticDigest,
} from "./helpers/seedAssetLibrary.mjs";
import {applyYaml, openSeeded} from "./helpers/localAssetPage.mjs";

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
