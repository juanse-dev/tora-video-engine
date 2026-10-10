import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {existsSync} from "node:fs";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium, expect, test} from "@playwright/test";
import {
  applyYaml,
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
} from "../browser/helpers/localAssetPage.mjs";
import {
  localAssetRef,
  readFixture,
} from "../browser/helpers/seedAssetLibrary.mjs";

// ASSET-006 A1: local assets survive a reload, a full browser restart and a
// new build served from the same origin. The spec owns its servers (vite
// preview on a fixed port, build A from dist/web, build B from dist/web-b) and
// its browser profiles (persistent contexts on temporary user-data dirs, system
// Chrome so the final MP4 render can encode H.264).
//
// Build A is whatever is in dist/web: CI runs `npm run web:build` first, so it
// is fresh there. Locally, rebuild (`npm run web:build`) after changing src/,
// otherwise this spec verifies a stale build. If dist/web is absent the spec
// builds it itself.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 4180;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const STORAGE_KEY = "tora-video-engine:project";
const BUILD_A_DIR = "dist/web";
const BUILD_B_DIR = "dist/web-b";
const VITE_CLI = join(
  dirname(createRequire(import.meta.url).resolve("vite/package.json")),
  "bin",
  "vite.js",
);

// Chrome can hold a just-closed profile for a moment on Windows (EBUSY).
const REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
};

const STORY = [
  'title: "Persistence story"',
  "scenes:",
  "  - type: intro",
  "    pose: formal",
  "    background: office",
  '    text: "Persistence"',
  "    duration: 1",
  "",
].join("\n");

// --- processes -------------------------------------------------------------

const runNode = (args) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";

    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveRun(output);
      } else {
        reject(new Error(`node ${args.join(" ")} exited ${code}\n${output}`));
      }
    });
  });

const reachable = async () => {
  try {
    const response = await fetch(`${ORIGIN}/index.html`, {
      signal: AbortSignal.timeout(2_000),
    });

    return response.ok;
  } catch {
    return false;
  }
};

const startPreview = async (outDir) => {
  expect(await reachable(), `port ${PORT} must be free`).toBe(false);

  const child = spawn(
    process.execPath,
    [
      VITE_CLI,
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(PORT),
      "--strictPort",
      "--outDir",
      outDir,
    ],
    {cwd: ROOT, stdio: ["ignore", "pipe", "pipe"]},
  );
  let output = "";
  let exited = false;
  let spawnError = null;

  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  // A failed spawn emits "error" (and no "exit"): surface it from the poll.
  child.on("error", (error) => {
    spawnError = error;
    exited = true;
  });
  child.on("exit", () => {
    exited = true;
  });

  const stop = async () => {
    if (!exited) {
      const gone = new Promise((done) => child.once("exit", done));

      child.kill();

      // Escalate if SIGTERM is ignored.
      const forced = setTimeout(() => child.kill("SIGKILL"), 5_000);

      try {
        await gone;
      } finally {
        clearTimeout(forced);
      }
    }

    await expect
      .poll(reachable, {timeout: 15_000, message: "server released port"})
      .toBe(false);
  };

  try {
    await expect
      .poll(
        async () => {
          if (spawnError !== null) {
            throw new Error(`vite preview failed to start: ${spawnError}`);
          }

          if (exited) {
            throw new Error(`vite preview exited early
${output}`);
          }

          return reachable();
        },
        {timeout: 30_000, message: `vite preview (${outDir}) on ${ORIGIN}`},
      )
      .toBe(true);
  } catch (error) {
    // Never leave the child running when start-up did not complete.
    if (!exited) {
      child.kill("SIGKILL");
    }

    throw error;
  }

  return {stop};
};

// --- browser profiles ------------------------------------------------------

const launchProfile = async (userDataDir) => {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless: true,
  });
  const page = context.pages()[0] ?? (await context.newPage());

  return {context, page};
};

const PROFILE_MARKER = "tora-persistence-profile-marker";

/** Drops a token file into the profile so a relaunch can prove it is the same dir. */
const markProfile = async (userDataDir) => {
  const token = randomUUID();

  await writeFile(join(userDataDir, PROFILE_MARKER), token);

  return token;
};

/**
 * Relaunches a profile, failing unless it is the directory that was marked:
 * the marker written before the restart must still be there, next to the
 * Chrome profile the first run created.
 */
const relaunchProfile = async (userDataDir, token) => {
  expect(await readFile(join(userDataDir, PROFILE_MARKER), "utf8")).toBe(token);
  expect(existsSync(join(userDataDir, "Default"))).toBe(true);

  return launchProfile(userDataDir);
};

// --- app helpers -----------------------------------------------------------

const section = (page, category) =>
  page.locator(`[data-my-assets="${category}"]`);
const cards = (page, category) =>
  section(page, category).locator("[data-local-asset-card]");
const previewImages = (page) => page.locator(".preview-frame img[src^='blob:']");

const upload = (fixture) => ({
  name: fixture.name,
  mimeType: fixture.meta.mimeType,
  buffer: Buffer.from(fixture.bytes),
});

const openApp = async (page) => {
  await page.goto(`${ORIGIN}/`, {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
};

/** Issue #24: mute before anything can play. */
const mutePlayer = async (page) => {
  // exact: "Unmute sound" also contains "mute sound", and clicking it would
  // turn the sound back on. Idempotent: a muted Player is left as it is.
  const mute = page.getByRole("button", {name: "Mute sound", exact: true});
  const unmute = page.getByRole("button", {name: "Unmute sound", exact: true});

  await expect(mute.or(unmute)).toBeVisible();

  if (await mute.isVisible()) {
    await mute.click();
  }

  await expect(unmute).toBeVisible();
};

const yamlSource = async (page) => {
  await page.getByRole("button", {name: "Open YAML"}).click();

  const source = await page.getByLabel("YAML source").inputValue();

  await page.getByRole("button", {name: "Open visual editor"}).click();

  return source;
};

const storedEnvelope = (page) =>
  page.evaluate(
    (key) => localStorage.getItem(key),
    STORAGE_KEY,
  );

/** Waits for the debounced writer, then returns the parsed envelope. */
const settledEnvelope = async (page, version) => {
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

const blobSources = (locator) =>
  locator.evaluateAll((images) => images.map((image) => image.src));

/**
 * The app state a user expects back: the Story with both refs, the two My
 * assets cards with decoded thumbnails and the Player showing both images.
 * Returns the runtime blob: URLs so callers can prove they were rebuilt.
 */
const expectLocalAssetsRestored = async (page, refs) => {
  const yaml = await yamlSource(page);

  expect(yaml).toContain(`pose: ${refs.pose}`);
  expect(yaml).toContain(`background: ${refs.background}`);

  const thumbnails = {};

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
    thumbnails[category] = await thumbnail.getAttribute("src");
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

  return {
    thumbnails: Object.values(thumbnails),
    preview: await blobSources(previewImages(page)),
  };
};

/** After a reload/restart nothing was imported again in this page. */
const expectNoImportInThisPage = async (page) => {
  for (const category of ["pose", "background"]) {
    await expect(section(page, category).getByRole("status")).toHaveText("");
  }
};

const expectFreshBlobUrls = (before, after) => {
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

const RENDER_FRAME_SECONDS = 0.5;

/** Renders a browser MP4 and checks that both local images are in it. */
const renderAndVerifyMp4 = async (page) => {
  const renderButton = page.getByRole("button", {name: "Render MP4"});
  const banner = page.locator(".render-banner");

  await expect
    .poll(async () => (await banner.textContent()) ?? "", {timeout: 20_000})
    .not.toContain("Checking browser render support");
  await expect(renderButton).toBeEnabled({timeout: 20_000});
  await expect(banner).toContainText("Browser MP4 rendering is ready.");
  await mutePlayer(page);

  const downloadPromise = page.waitForEvent("download", {timeout: 120_000});

  await renderButton.click();

  const path = await (await downloadPromise).path();

  expect(path).not.toBeNull();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-render-state",
    "success",
    {timeout: 30_000},
  );
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-authoring-locked",
    "false",
  );

  const frame = await decodeMp4Frame(path, RENDER_FRAME_SECONDS);

  // Positive control, then the local pose and background are really in it.
  expect(meanLuminance(frame)).toBeGreaterThan(20);
  expect(regionRatio(frame, POSE_MAGENTA_REGION, isMagenta)).toBeGreaterThan(
    0.9,
  );
  expect(regionRatio(frame, BACKGROUND_TOP_REGION, isCyan)).toBeGreaterThan(
    0.9,
  );
  expect(
    regionRatio(frame, BACKGROUND_BOTTOM_REGION, isYellow),
  ).toBeGreaterThan(0.9);
};

// --- the test --------------------------------------------------------------

test("local assets persist across reload, browser restart and a new build", async () => {
  test.setTimeout(420_000);

  const pose = await readFixture("pose-magenta.png");
  const background = await readFixture("background-cyan.jpg");
  const refs = {
    pose: localAssetRef("pose", pose.digest),
    background: localAssetRef("background", background.digest),
  };
  const profiles = [];
  let server = null;
  let session = null;

  const closeSession = async () => {
    const current = session;

    session = null;
    await current?.context.close();
  };

  try {
    // Build A is the normal production build (CI builds it in an earlier
    // step); build it only when this spec runs on its own.
    if (!existsSync(join(ROOT, BUILD_A_DIR, "index.html"))) {
      await runNode([VITE_CLI, "build"]);
    }

    server = await startPreview(BUILD_A_DIR);

    const profileDir = await mkdtemp(join(tmpdir(), "tora-persist-"));

    profiles.push(profileDir);

    const profileToken = await markProfile(profileDir);
    let imported;

    await test.step("import and apply both fixtures through the UI", async () => {
      session = await launchProfile(profileDir);

      const {page} = session;

      await openApp(page);
      await mutePlayer(page);
      await applyYaml(page, STORY);
      await page.getByRole("button", {name: "Open visual editor"}).click();

      await section(page, "pose")
        .locator('input[type="file"]')
        .setInputFiles(upload(pose));
      await expect(section(page, "pose").getByRole("status")).toHaveText(
        'Imported "pose-magenta".',
      );
      await section(page, "background")
        .locator('input[type="file"]')
        .setInputFiles(upload(background));
      await expect(
        section(page, "background").getByRole("status"),
      ).toHaveText('Imported "background-cyan".');

      // The refs recorded from the YAML editor are the fixtures' digests.
      const yaml = await yamlSource(page);
      const recordedRefs = {
        pose: yaml.match(/pose: (local:pose:sha256:[0-9a-f]{64})/u)?.[1],
        background: yaml.match(
          /background: (local:background:sha256:[0-9a-f]{64})/u,
        )?.[1],
      };

      expect(recordedRefs).toEqual(refs);

      imported = await expectLocalAssetsRestored(page, refs);

      const {raw, envelope} = await settledEnvelope(page, 2);

      expect(raw).not.toContain("blob:");
      expect(JSON.stringify(envelope.story)).toContain(refs.pose);
      expect(JSON.stringify(envelope.story)).toContain(refs.background);
    });

    await test.step("reload: Story, My assets and Player return without re-import", async () => {
      const {page} = session;

      await page.reload({waitUntil: "domcontentloaded"});
      await waitForOwner(page);
      await mutePlayer(page);

      const restored = await expectLocalAssetsRestored(page, refs);

      await expectNoImportInThisPage(page);
      expectFreshBlobUrls(imported, restored);
      await settledEnvelope(page, 2);
      imported = restored;
    });

    await test.step("restart: same profile, whole browser relaunched", async () => {
      await closeSession();
      session = await relaunchProfile(profileDir, profileToken);

      const {page} = session;

      await openApp(page);
      await mutePlayer(page);

      const restored = await expectLocalAssetsRestored(page, refs);

      await expectNoImportInThisPage(page);
      expectFreshBlobUrls(imported, restored);
      await settledEnvelope(page, 2);
      imported = restored;
    });

    await test.step("a profile with only bundled edits stays at envelope version 1", async () => {
      const bundledProfile = await mkdtemp(join(tmpdir(), "tora-persist-v1-"));

      profiles.push(bundledProfile);

      const bundled = await launchProfile(bundledProfile);

      try {
        await openApp(bundled.page);
        await bundled.page
          .locator(".pose-grid")
          .first()
          .getByRole("button", {name: /Panic/u})
          .click();

        const {raw} = await settledEnvelope(bundled.page, 1);

        expect(raw).not.toContain("local:");
        expect(await bundled.page.locator("[data-local-asset-card]").count())
          .toBe(0);

        await bundled.page.reload({waitUntil: "domcontentloaded"});
        await waitForOwner(bundled.page);
        await settledEnvelope(bundled.page, 1);
      } finally {
        await bundled.context.close();
      }
    });

    await test.step("build A -> B: second build, same origin, same profile", async () => {
      await closeSession();

      // A different build, not a copy: unminified, so the bundle differs.
      await runNode([
        VITE_CLI,
        "build",
        "--outDir",
        BUILD_B_DIR,
        "--minify",
        "false",
      ]);

      const indexA = await readFile(join(ROOT, BUILD_A_DIR, "index.html"), "utf8");
      const indexB = await readFile(join(ROOT, BUILD_B_DIR, "index.html"), "utf8");

      expect(indexB).not.toBe(indexA);

      await server.stop();
      server = await startPreview(BUILD_B_DIR);

      // The origin now serves build B.
      const served = await (await fetch(`${ORIGIN}/index.html`)).text();

      expect(served).toBe(indexB);

      session = await relaunchProfile(profileDir, profileToken);

      const {page} = session;

      await openApp(page);

      // The page really runs build B's code: every module script it loaded is
      // referenced by B's index.html and by none of A's.
      const moduleScripts = await page.evaluate(() =>
        [...document.querySelectorAll("script[type=module]")].map((script) =>
          script.getAttribute("src"),
        ),
      );

      expect(moduleScripts.length).toBeGreaterThan(0);

      for (const src of moduleScripts) {
        expect(src).toBeTruthy();
        expect(indexB).toContain(src);
        expect(indexA).not.toContain(src);
      }

      await mutePlayer(page);

      const restored = await expectLocalAssetsRestored(page, refs);

      await expectNoImportInThisPage(page);
      expectFreshBlobUrls(imported, restored);
      await settledEnvelope(page, 2);

      await renderAndVerifyMp4(page);
    });
  } finally {
    await session?.context.close().catch(() => {});
    await server?.stop().catch(() => {});
    await rm(join(ROOT, BUILD_B_DIR), REMOVE_OPTIONS);
    await Promise.all(profiles.map((dir) => rm(dir, REMOVE_OPTIONS)));
  }
});
