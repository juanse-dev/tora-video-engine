import {expect, test} from "@playwright/test";
import {
  buildStoryYaml,
  deleteAssetRows,
  fixtureRecord,
  localAssetRef,
  metadataOnlyRecord,
  readFixture,
  seedAssetLibrary,
} from "./helpers/seedAssetLibrary.mjs";
import {
  applyYaml,
  isBrowserRenderSupported,
  listRemotionOpfsEntries,
  openSeeded,
  waitForOwner,
} from "./helpers/localAssetPage.mjs";

const STORAGE_KEY = "tora-video-engine:project";

const waitForStoryPersisted = async (page, needle) => {
  await expect
    .poll(
      () =>
        page.evaluate(
          ([key, text]) => (window.localStorage.getItem(key) ?? "").includes(text),
          [STORAGE_KEY, needle],
        ),
      {timeout: 10_000},
    )
    .toBe(true);
};

const blobImages = (page) => page.locator(".preview-frame img[src^='blob:']");

/** SHA-256 of what each blob: image in the Player actually points at. */
const blobImageDigests = (page) =>
  page.evaluate(async () => {
    const digests = [];

    for (const image of document.querySelectorAll(
      ".preview-frame img[src^='blob:']",
    )) {
      const bytes = await (await fetch(image.src)).arrayBuffer();
      const hash = await crypto.subtle.digest("SHA-256", bytes);

      digests.push(
        [...new Uint8Array(hash)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      );
    }

    return digests.sort();
  });

const frameOf = async (page) =>
  Number(await page.locator("[data-tora-frame]").first().getAttribute("data-tora-frame"));

test("local pose and background render inside the Player from verified blob: URLs", async ({
  page,
}) => {
  const pose = await readFixture("pose-magenta.png");
  const background = await readFixture("background-cyan.jpg");

  await openSeeded(page, [
    fixtureRecord("pose", pose),
    fixtureRecord("background", background),
  ]);
  await applyYaml(
    page,
    buildStoryYaml([
      {
        pose: localAssetRef("pose", pose.digest),
        background: localAssetRef("background", background.digest),
      },
    ]),
  );

  await expect(blobImages(page)).toHaveCount(2);
  await expect(page.locator("[data-missing-local-asset]")).toHaveCount(0);
  await expect(page.locator("[data-pending-local-asset]")).toHaveCount(0);
  await expect(page.locator("[data-local-asset-status]")).toHaveCount(0);
  expect(await blobImageDigests(page)).toEqual(
    [pose.digest, background.digest].sort(),
  );
});

test("the Player does not advance while a local image is still loading", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Remotion's <Img> keeps the Player buffering until img.decode()
    // settles, so holding decode() keeps a blob image "still loading"
    // without touching how React assigns src.
    const nativeDecode = HTMLImageElement.prototype.decode;
    const queued = [];
    let holding = true;

    HTMLImageElement.prototype.decode = function () {
      if (!holding || !this.src.startsWith("blob:")) {
        return nativeDecode.call(this);
      }

      return new Promise((resolve, reject) => {
        queued.push(() => nativeDecode.call(this).then(resolve, reject));
      });
    };
    window.__heldBlobImages = () => queued.length;
    window.__releaseBlobImages = () => {
      holding = false;

      for (const apply of queued.splice(0)) {
        apply();
      }
    };
  });

  const pose = await readFixture("pose-magenta.png");
  const background = await readFixture("background-cyan.jpg");

  await openSeeded(page, [
    fixtureRecord("pose", pose),
    fixtureRecord("background", background),
  ]);
  await applyYaml(
    page,
    buildStoryYaml([
      {
        pose: localAssetRef("pose", pose.digest),
        background: localAssetRef("background", background.digest),
      },
    ]),
  );

  await expect
    .poll(() => page.evaluate(() => window.__heldBlobImages()), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);

  // The Story has no audio. Muting keeps Remotion from waiting on the
  // shared AudioContext to resume after buffering, which never settles on
  // a Linux runner without an audio device.
  await page.getByRole("button", {name: "Mute sound"}).click();
  const playButton = page.getByRole("button", {name: "Play video"});
  await expect(playButton).toBeVisible();
  await playButton.click();
  // Playback was requested; the Player only waits for the held images.
  await expect(page.getByRole("button", {name: "Pause video"})).toBeVisible();
  await expect.poll(() => frameOf(page)).toBe(0);
  await page.waitForTimeout(500);
  expect(await frameOf(page)).toBe(0);

  await page.evaluate(() => window.__releaseBlobImages());

  const playbackState = () =>
    page.evaluate(() => ({
      frame: document.querySelector("[data-tora-frame]")?.getAttribute("data-tora-frame"),
      held: window.__heldBlobImages(),
      images: [...document.querySelectorAll("img")]
        .filter((image) => image.src.startsWith("blob:"))
        .map((image) => ({
          complete: image.complete,
          naturalWidth: image.naturalWidth,
        })),
      playing: document.querySelector("button[aria-label='Pause video']") !== null,
    }));

  await expect
    .poll(() => frameOf(page), {
      message: "Player did not advance after the local images loaded",
      timeout: 10_000,
    })
    .toBeGreaterThan(0)
    .catch(async (error) => {
      throw new Error(
        `${error.message}\nPlayback state: ${JSON.stringify(await playbackState())}`,
      );
    });
});

test("a deleted background record shows a placeholder for that ref only and blocks render", async ({
  page,
}) => {
  const pose = await readFixture("pose-magenta.png");
  const background = await readFixture("background-cyan.jpg");
  const backgroundRef = localAssetRef("background", background.digest);

  await openSeeded(page, [
    fixtureRecord("pose", pose),
    fixtureRecord("background", background),
  ]);
  await applyYaml(
    page,
    buildStoryYaml([
      {
        pose: localAssetRef("pose", pose.digest),
        background: backgroundRef,
      },
    ]),
  );
  await expect(blobImages(page)).toHaveCount(2);
  await waitForStoryPersisted(page, background.digest);

  await deleteAssetRows(page, [backgroundRef]);
  await page.reload({waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const preview = page.locator(".preview-frame");
  const placeholders = preview.locator("[data-missing-local-asset]");

  await expect(placeholders).toHaveCount(1);
  await expect(placeholders).toHaveAttribute(
    "data-missing-local-asset",
    backgroundRef,
  );
  await expect(blobImages(page)).toHaveCount(1);
  expect(await blobImageDigests(page)).toEqual([pose.digest]);
  await expect(page.locator("[data-local-asset-status]")).toContainText(
    "1 local asset is missing in this browser. Scene 1 shows a placeholder.",
  );
  await expect(page.getByRole("button", {name: "Render MP4"})).toBeDisabled();
  await expect(page.locator(".render-banner")).toHaveAttribute(
    "data-local-asset-block",
    "Browser render is blocked because 1 local asset(s) are unavailable in this browser.",
  );
});

test("a corrupt blob gets a placeholder for that ref only", async ({page}) => {
  const pose = await readFixture("pose-magenta.png");
  const background = await readFixture("background-cyan.jpg");

  await openSeeded(page, [
    fixtureRecord("pose", pose),
    // Metadata and key claim the JPEG, the stored bytes are the PNG.
    fixtureRecord("background", background, {bytesFrom: pose}),
  ]);
  await applyYaml(
    page,
    buildStoryYaml([
      {
        pose: localAssetRef("pose", pose.digest),
        background: localAssetRef("background", background.digest),
      },
    ]),
  );

  const placeholders = page.locator("[data-missing-local-asset]");

  await expect(placeholders).toHaveCount(1);
  await expect(placeholders).toHaveAttribute(
    "data-missing-local-asset",
    localAssetRef("background", background.digest),
  );
  await expect(blobImages(page)).toHaveCount(1);
  expect(await blobImageDigests(page)).toEqual([pose.digest]);
});

test("a Story over the ref cap shows the budget message, no Player, and reads no blobs", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__idbGetStores = [];

    const nativeGet = IDBObjectStore.prototype.get;

    IDBObjectStore.prototype.get = function (...args) {
      window.__idbGetStores.push(this.name);

      return nativeGet.apply(this, args);
    };
  });

  const meta = {mimeType: "image/png", byteSize: 1000, width: 10, height: 10};
  const records = Array.from({length: 65}, (_, index) =>
    metadataOnlyRecord("pose", index + 1, meta),
  );

  await openSeeded(page, records);
  await applyYaml(
    page,
    buildStoryYaml(
      records.map((record) => ({pose: record.ref, background: "office"})),
    ),
  );

  const message = page.locator("[data-local-asset-over-budget]");

  await expect(message).toBeVisible();
  await expect(message).toHaveAttribute("role", "status");
  await expect(message).toContainText("Uses 65 local assets (limit 64).");
  await expect(page.locator(".preview-frame [data-tora-frame]")).toHaveCount(0);
  await expect(page.getByRole("button", {name: "Play video"})).toHaveCount(0);
  await expect(page.getByRole("button", {name: "Render MP4"})).toBeDisabled();
  expect(
    await page.evaluate(() => window.__idbGetStores.includes("blobs")),
  ).toBe(false);

  // Back to a small Story: the Player mounts again and plays frames.
  await applyYaml(
    page,
    buildStoryYaml([{pose: "formal", background: "office"}]),
  );
  await expect(message).toHaveCount(0);
  await expect(page.getByRole("button", {name: "Play video"})).toBeVisible();
  await page.getByRole("button", {name: "Play video"}).click();
  await expect.poll(() => frameOf(page), {timeout: 10_000}).toBeGreaterThan(0);
});

test("changing the pose ref quickly A to B to C ends with C displayed", async ({
  page,
}) => {
  const a = await readFixture("pose-magenta.png");
  const b = await readFixture("background-cyan.jpg");
  const c = await readFixture("background-noext");

  await openSeeded(page, [
    fixtureRecord("pose", a),
    fixtureRecord("pose", b),
    fixtureRecord("pose", c),
  ]);

  for (const fixture of [a, b, c]) {
    await applyYaml(
      page,
      buildStoryYaml([
        {pose: localAssetRef("pose", fixture.digest), background: "office"},
      ]),
    );
  }

  await expect
    .poll(() => blobImageDigests(page), {timeout: 10_000})
    .toEqual([c.digest]);
  await expect(page.locator("[data-missing-local-asset]")).toHaveCount(0);
  await expect(page.locator("[data-pending-local-asset]")).toHaveCount(0);
});

test("without Web Locks My assets is disabled and bundled Stories still preview", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
  });

  await page.goto("/", {waitUntil: "domcontentloaded"});

  const preview = page.locator(".preview-frame");

  await expect(preview.locator("img").first()).toBeVisible();
  await expect(page.locator("[data-missing-local-asset]")).toHaveCount(0);
  await expect(page.locator("[data-local-asset-status]")).toHaveCount(0);

  const pose = await readFixture("pose-magenta.png");

  await applyYaml(
    page,
    buildStoryYaml([
      {pose: localAssetRef("pose", pose.digest), background: "office"},
    ]),
  );

  await expect(page.locator("[data-missing-local-asset]")).toHaveCount(1);
  await expect(page.locator("[data-local-asset-status]")).toContainText(
    "My assets needs a browser with Web Locks support.",
  );
  await expect(page.getByRole("button", {name: "Render MP4"})).toBeDisabled();
  await expect(page.locator(".render-banner")).toHaveAttribute(
    "data-local-asset-block",
    /Web Locks/u,
  );
});

// --- Render preparation ("Checking local assets…") ---------------------------

/**
 * Seeds a one-pose Story and makes the next blob reads wait for
 * `window.__releaseBlobReads()`, so the render's verification step can be observed.
 */
const openForPreparation = async (page) => {
  await page.addInitScript(() => {
    const nativeArrayBuffer = Blob.prototype.arrayBuffer;
    const waiting = [];

    window.__holdBlobReads = false;
    Blob.prototype.arrayBuffer = function () {
      if (!window.__holdBlobReads) {
        return nativeArrayBuffer.call(this);
      }

      return new Promise((resolve, reject) => {
        waiting.push(() => nativeArrayBuffer.call(this).then(resolve, reject));
      });
    };
    window.__releaseBlobReads = () => {
      window.__holdBlobReads = false;

      for (const run of waiting.splice(0)) {
        run();
      }
    };
  });

  const pose = await readFixture("pose-magenta.png");

  await openSeeded(page, [fixtureRecord("pose", pose)]);

  if (!(await isBrowserRenderSupported(page))) {
    test.skip(true, "Browser web rendering is unavailable in this runtime");
  }

  await applyYaml(
    page,
    buildStoryYaml([
      {pose: localAssetRef("pose", pose.digest), background: "office"},
    ]),
  );
  await expect(blobImages(page)).toHaveCount(1);
  await expect(page.getByRole("button", {name: "Render MP4"})).toBeEnabled();

  // Forget the verified payload (as another tab's change message would) and
  // hold every blob read from now on.
  await page.evaluate((digest) => {
    window.__holdBlobReads = true;

    const channel = new BroadcastChannel("tora-video-engine:asset-library");

    channel.postMessage({
      type: "asset-library-changed",
      refs: [],
      digests: [digest],
    });
    channel.close();
  }, pose.digest);

  return pose;
};

test("Cancel Render during local asset preparation unlocks authoring without OPFS entries", async ({
  page,
}) => {
  await openForPreparation(page);
  await page.getByRole("button", {name: "Render MP4"}).click();

  await expect(page.locator(".render-banner")).toContainText(
    "Checking local assets…",
  );
  // The check has no measurable progress: no 0% bar yet.
  await expect(
    page.locator("progress[aria-label='Browser render progress']"),
  ).toHaveCount(0);
  await expect(page.getByLabel("YAML source")).toBeDisabled();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-authoring-locked",
    "true",
  );

  await page.getByRole("button", {name: "Cancel Render"}).click();
  await page.evaluate(() => window.__releaseBlobReads());

  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-render-state",
    "idle",
  );
  await expect(page.locator(".render-banner")).toContainText(
    "Browser render cancelled.",
  );
  await expect(page.getByLabel("YAML source")).toBeEnabled();
  expect(await listRemotionOpfsEntries(page)).toEqual([]);
});

test("a read failure during local asset preparation ends in the failure state with authoring unlocked", async ({
  context,
  page,
}) => {
  await openForPreparation(page);
  await page.getByRole("button", {name: "Render MP4"}).click();
  await expect(page.locator(".render-banner")).toContainText(
    "Checking local assets…",
  );

  // Another tab deletes the database; this tab's connection is closed by versionchange.
  const other = await context.newPage();

  await other.goto("/", {waitUntil: "domcontentloaded"});
  await other.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase("tora-video-engine-assets");

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      }),
  );
  await page.evaluate(() => window.__releaseBlobReads());

  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-render-state",
    "failure",
    {timeout: 15_000},
  );
  await expect(page.locator(".render-banner")).toContainText(
    "Browser render failed:",
  );
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-authoring-locked",
    "false",
  );
  await expect(page.getByRole("button", {name: "Cancel Render"})).toHaveCount(0);
  await expect(page.getByLabel("YAML source")).toBeEnabled();
});
