// Page and MP4 helpers for tests/gate/local-assets-gate.spec.mjs (ASSET-006
// Part B against a deployed origin). The patterns come from
// tests/persistence/local-assets-persistence.spec.mjs, written as helpers
// because that file is a spec and cannot be imported.

import {randomUUID} from "node:crypto";
import {existsSync} from "node:fs";
import {readFile, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {chromium, expect} from "@playwright/test";
import {probeMp4} from "../../helpers/ffmpeg.mjs";
import {cards, section} from "../../browser/helpers/localAssetFlows.mjs";
import {
  BACKGROUND_BOTTOM_REGION,
  BACKGROUND_TOP_REGION,
  decodeMp4Frame,
  isCyan,
  isMagenta,
  isYellow,
  meanLuminance,
  POSE_MAGENTA_REGION,
  regionRatio,
  waitForOwner,
} from "../../browser/helpers/localAssetPage.mjs";

export const STORAGE_KEY = "tora-video-engine:project";
const PROFILE_MARKER = "tora-gate-profile-marker";

// The Story is the v0.2 envelope's (friday-deploy, 4 scenes x 3 s = 12 s).
// Local assets land on scene 1 (an intro, the layout the shared colour regions
// describe): its middle is 1.5 s. Scene 3 (6-9 s) stays bundled: 7.5 s.
export const LOCAL_SCENE_SECONDS = 1.5;
export const BUNDLED_SCENE_SECONDS = 7.5;

// --- browser ---------------------------------------------------------------

/**
 * Chrome (observed on 154, Windows) crashes with an access violation when a
 * download starts in a profile whose History already lists a download from an
 * earlier session; the page and browser close under the test. Deleting only
 * the History database between sessions avoids it. Cookies, localStorage,
 * IndexedDB and the rest of the profile are untouched, so it is still the
 * same profile as far as the app is concerned.
 */
const clearDownloadHistory = (profileDir) =>
  Promise.all(
    ["History", "History-journal"].map((name) =>
      rm(join(profileDir, "Default", name), {force: true}),
    ),
  );

/** System Chrome on the gate profile (G5): never the user's own profile. */
export const launchGateProfile = async ({profileDir, baseURL, headed}) => {
  await clearDownloadHistory(profileDir);

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: !headed,
    baseURL,
    acceptDownloads: true,
  });
  const page = context.pages()[0] ?? (await context.newPage());

  return {context, page};
};

/** The full version (154.0.8037.98); the user agent only reports 154.0.0.0. */
export const chromeVersion = async (page) => {
  const session = await page.context().newCDPSession(page);

  try {
    const {product} = await session.send("Browser.getVersion");

    return product.match(/Chrome\/([\d.]+)/u)?.[1] ?? product;
  } finally {
    await session.detach();
  }
};

/** Drops a token file into the profile so a relaunch can prove it is the same dir. */
export const markProfile = async (profileDir) => {
  const token = randomUUID();

  await writeFile(join(profileDir, PROFILE_MARKER), token);

  return token;
};

/** Fails unless `profileDir` is the directory that was marked, with Chrome's profile in it. */
export const expectSameProfile = async (profileDir, token) => {
  expect(await readFile(join(profileDir, PROFILE_MARKER), "utf8")).toBe(token);
  expect(existsSync(join(profileDir, "Default"))).toBe(true);
};

// --- app -------------------------------------------------------------------

export const openApp = async (page) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
};

/** Issue #24: mute before anything can play. Idempotent. */
export const mutePlayer = async (page) => {
  // exact: "Unmute sound" also contains "mute sound".
  const mute = page.getByRole("button", {name: "Mute sound", exact: true});
  const unmute = page.getByRole("button", {name: "Unmute sound", exact: true});

  await expect(mute.or(unmute)).toBeVisible();

  if (await mute.isVisible()) {
    await mute.click();
  }

  await expect(unmute).toBeVisible();
};

export const storedEnvelope = (page) =>
  page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);

/** Waits for the debounced writer, then returns the parsed envelope. */
export const settledEnvelope = async (page, version) => {
  let raw = null;

  await expect
    .poll(
      async () => {
        raw = await storedEnvelope(page);

        return raw === null ? null : JSON.parse(raw).version;
      },
      {timeout: 15_000, message: `localStorage envelope version ${version}`},
    )
    .toBe(version);

  return {raw, envelope: JSON.parse(raw)};
};

const previewImages = (page) =>
  page.locator(".preview-frame img[src^='blob:']");

const blobSources = (locator) =>
  locator.evaluateAll((images) => images.map((image) => image.src));

/** The YAML editor's text; leaves the app in the visual editor. */
export const readYaml = async (page) => {
  await page.getByRole("button", {name: "Open YAML"}).click();

  const source = await page.getByLabel("YAML source").inputValue();

  await page.getByRole("button", {name: "Open visual editor"}).click();

  return source;
};

/**
 * The app state a user expects back: the Story with both refs, the two My
 * assets cards with decoded thumbnails and the Player showing both images.
 * Returns the runtime blob: URLs so callers can prove they were rebuilt.
 */
export const expectLocalAssetsRestored = async (page, refs) => {
  const yaml = await readYaml(page);

  expect(yaml).toContain(`pose: ${refs.pose}`);
  expect(yaml).toContain(`background: ${refs.background}`);

  const thumbnails = [];

  for (const category of ["pose", "background"]) {
    const card = section(page, category).locator(
      `[data-local-asset-card="${refs[category]}"]`,
    );

    await expect(
      section(page, category).getByRole("heading", {name: "My assets · 1"}),
    ).toBeVisible();
    await expect(cards(page, category)).toHaveCount(1);
    await expect(card).toContainText("Current");

    const thumbnail = card.locator("img");

    await expect(thumbnail).toHaveAttribute("src", /^blob:/u);
    await expect
      .poll(() => thumbnail.evaluate((image) => image.naturalWidth))
      .toBeGreaterThan(0);
    thumbnails.push(await thumbnail.getAttribute("src"));
  }

  await expect(previewImages(page)).toHaveCount(2);
  await expect
    .poll(() =>
      previewImages(page).evaluateAll((images) =>
        images.every((image) => image.naturalWidth > 0),
      ),
    )
    .toBe(true);
  await expect(page.locator("[data-missing-local-asset]")).toHaveCount(0);

  return {thumbnails, preview: await blobSources(previewImages(page))};
};

/** After a reload/restart nothing was imported again in this page. */
export const expectNoImportInThisPage = async (page) => {
  for (const category of ["pose", "background"]) {
    await expect(section(page, category).getByRole("status")).toHaveText("");
  }
};

export const expectFreshBlobUrls = (before, after) => {
  expect(after.thumbnails.length).toBeGreaterThan(0);
  expect(after.preview.length).toBeGreaterThan(0);

  const previous = new Set([...before.thumbnails, ...before.preview]);

  for (const url of [...after.thumbnails, ...after.preview]) {
    expect(url).toMatch(/^blob:/u);
    expect(previous.has(url), `${url} must be rebuilt, not persisted`).toBe(
      false,
    );
  }
};

// --- render and MP4 --------------------------------------------------------

/** Renders a browser MP4, saves the download to `savePath`, returns it. */
export const renderAndSave = async (page, savePath) => {
  const renderButton = page.getByRole("button", {name: "Render MP4"});
  const banner = page.locator(".render-banner");

  await expect
    .poll(async () => (await banner.textContent()) ?? "", {timeout: 30_000})
    .not.toContain("Checking browser render support");
  await expect(renderButton).toBeEnabled({timeout: 30_000});
  // After an earlier render in the same page the banner reports that one.
  await expect(banner).toContainText(
    /Browser MP4 rendering is ready.|rendered and downloaded successfully/u,
  );
  await mutePlayer(page);

  const downloadPromise = page.waitForEvent("download", {timeout: 240_000});

  await renderButton.click();

  const download = await downloadPromise;

  await download.saveAs(savePath);
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-render-state",
    "success",
    {timeout: 60_000},
  );
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-authoring-locked",
    "false",
  );

  return savePath;
};

/** H.264, 1080x1920, 30 FPS, 360 frames (12 s), video only. Returns the probe. */
export const expectMp4Metadata = async (path) => {
  const info = await probeMp4(path);

  expect(info.codec).toBe("h264");
  expect(info.width).toBe(1080);
  expect(info.height).toBe(1920);
  expect(info.fps).toBeCloseTo(30, 1);
  expect(info.frames).toBe(360);
  expect(info.durationSeconds).toBeCloseTo(12, 1);
  expect(info.hasAudio).toBe(false);

  return info;
};

/**
 * The local-asset scene (scene 1, middle) shows the magenta pose over the
 * cyan/yellow background; the bundled scene (scene 3, middle) does not.
 */
export const expectLocalAssetFrames = async (path) => {
  const local = await decodeMp4Frame(path, LOCAL_SCENE_SECONDS);
  const bundled = await decodeMp4Frame(path, BUNDLED_SCENE_SECONDS);

  // Positive controls: neither frame is black.
  expect(meanLuminance(local)).toBeGreaterThan(20);
  expect(meanLuminance(bundled)).toBeGreaterThan(20);

  expect(regionRatio(local, POSE_MAGENTA_REGION, isMagenta)).toBeGreaterThan(
    0.9,
  );
  expect(regionRatio(local, BACKGROUND_TOP_REGION, isCyan)).toBeGreaterThan(
    0.9,
  );
  expect(
    regionRatio(local, BACKGROUND_BOTTOM_REGION, isYellow),
  ).toBeGreaterThan(0.9);

  expect(regionRatio(bundled, POSE_MAGENTA_REGION, isMagenta)).toBeLessThan(
    0.1,
  );
  expect(regionRatio(bundled, BACKGROUND_TOP_REGION, isCyan)).toBeLessThan(0.1);
  expect(regionRatio(bundled, BACKGROUND_BOTTOM_REGION, isYellow)).toBeLessThan(
    0.1,
  );
};
