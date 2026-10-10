import {readFile} from "node:fs/promises";
import {chromium, expect, test} from "@playwright/test";
import {parse as parseYaml} from "yaml";
import {
  decodeMp4Frame,
  isBrowserRenderSupported,
  meanLuminance,
  waitForOwner,
} from "../browser/helpers/localAssetPage.mjs";
import {probeMp4} from "../helpers/ffmpeg.mjs";
import {attachNetworkGuard} from "./helpers/networkGuard.mjs";

// GATE-001 T3: the WEB-007 manual golden checklist on the bundled canonical
// Story ("Deploy Friday"), against the deployed origin (`use.baseURL`). Phase A
// only. Runs in its own fresh, non-persistent system-Chrome context with the
// network guard attached; each checklist item is one test and is recorded
// through `recordResult` below.
//
// The items run in order on one page and depend on each other (an edit, a
// reload that restores it, a render of it), so the describe is serial: after a
// failure the remaining items are reported as not run.

const PHASE = process.env.TORA_GATE_PHASE;
const CAPTION_EDIT = "WEB-007 golden caption";
const ORIGINAL_FIRST_CAPTION =
  "Tora tiene una regla: Nunca desplegar en viernes.";
const SECOND_CAPTION =
  "Pero es solo un cambio pequeño... qué es lo peor que podría pasar?";
const RENDER_TIMEOUT_MS = 220_000;

// --- result recording ------------------------------------------------------

const results = new Map();

/**
 * GATE-001 INTEGRATION HOOK (T3 -> T1 report plumbing). The only place this
 * spec reports a WEB-007 checklist result. `key` is `web007.<item>`,
 * `status` is "passed" or "failed", `detail` is a short message (the failure
 * message when failed).
 *
 * T1's report module was not available when this spec was written. After
 * rebasing onto T1, replace the body with a call to its
 * `recordResult(stateDir, key, {status, detail})` (tests/gate/helpers/
 * report.mjs or gateState.mjs). Until then the results are kept in memory and
 * attached to the Playwright report as `web007-results.json`.
 */
const recordResult = async (key, {status, detail}) => {
  results.set(key, {status, detail});
};

// --- browser ---------------------------------------------------------------

let browser = null;
let context = null;
let page = null;
let guard = null;
let exportedYaml = null;
let renderedMp4 = null;

/** Issue #24: mute the Player before anything can play. Idempotent. */
const mutePlayer = async () => {
  const mute = page.getByRole("button", {name: "Mute sound", exact: true});
  const unmute = page.getByRole("button", {name: "Unmute sound", exact: true});

  await expect(mute.or(unmute)).toBeVisible();

  if (await mute.isVisible()) {
    await mute.click();
  }

  await expect(unmute).toBeVisible();
};

const openApp = async () => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await mutePlayer();
};

const shell = () => page.locator(".app-shell");
const sceneItems = () => page.locator(".scene-list-item");
const renderButton = () => page.getByRole("button", {name: "Render MP4"});
const preview = () => page.locator(".preview-frame");

const expectPreviewCaption = async (text) => {
  await expect
    .poll(() =>
      preview()
        .locator("[data-caption-line]")
        .allTextContents()
        .then((lines) => lines.join(" ")),
    )
    .toBe(text);
};

const expectEditorClean = async () => {
  await expect(shell()).toHaveAttribute("data-visual-state", "clean");
  await expect(shell()).toHaveAttribute("data-visual-pending", "false");
};

const downloadActiveYaml = async () => {
  const downloadPromise = page.waitForEvent("download");

  await page
    .getByRole("button", {name: "Export active Story YAML"})
    .first()
    .click();

  const download = await downloadPromise;
  const path = await download.path();

  return {
    filename: download.suggestedFilename(),
    text: await readFile(path, "utf8"),
  };
};

/** Starts a render and waits until the app reports it is in flight. */
const startRender = async () => {
  await expect(renderButton()).toBeEnabled();
  await renderButton().click();
  await expect(shell()).toHaveAttribute("data-render-state", "rendering");
};

/** One checklist item = one test; the outcome goes through `recordResult`. */
const item = (key, title, body, {timeout} = {}) => {
  test(`${key}: ${title}`, async () => {
    if (timeout !== undefined) {
      test.setTimeout(timeout);
    }

    try {
      await body();
      await recordResult(`web007.${key}`, {status: "passed", detail: title});
    } catch (error) {
      await recordResult(`web007.${key}`, {
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
};

// --- the checklist ---------------------------------------------------------

test.describe("WEB-007 golden on the bundled canonical Story", () => {
  test.skip(PHASE === "B", "The WEB-007 golden runs in phase A only");
  test.describe.configure({mode: "serial"});

  test.beforeAll(async ({}, testInfo) => {
    const {baseURL, headless} = testInfo.project.use;

    // A fresh, non-persistent context: nothing is shared with the gate
    // profile, and the Story starts as the bundled canonical one.
    browser = await chromium.launch({
      channel: "chrome",
      headless: headless !== false,
    });
    context = await browser.newContext({baseURL, acceptDownloads: true});
    guard = attachNetworkGuard(context, {fixtureBuffers: []});
    page = await context.newPage();
    await openApp();
  });

  test.afterAll(async ({}, testInfo) => {
    await testInfo.attach("web007-results.json", {
      body: JSON.stringify(Object.fromEntries(results), null, 2),
      contentType: "application/json",
    });
    await context?.close();
    await browser?.close();
  });

  item(
    "loads-bundled-assets",
    "the app loads the canonical Story with the bundled poses and backgrounds",
    async () => {
      await expect(page.locator("#preview-heading")).toHaveText(
        "Deploy Friday",
      );
      await expect(page.getByText("Scenes (4)")).toBeVisible();
      await expectPreviewCaption(ORIGINAL_FIRST_CAPTION);

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

      // Every bundled thumbnail and the Player's own images actually decoded.
      await expect
        .poll(() =>
          page
            .locator(".asset-catalog img.asset-thumbnail")
            .evaluateAll((images) =>
              images.length >= 6 &&
              images.every((image) => image.naturalWidth > 0),
            ),
        )
        .toBe(true);
      await expect
        .poll(() =>
          preview()
            .locator("img")
            .evaluateAll((images) =>
              images.length >= 2 &&
              images.every((image) => image.naturalWidth > 0),
            ),
        )
        .toBe(true);
      await expect(
        preview().locator('img[src*="characters/tora/formal.png"]'),
      ).toBeVisible();
      await expect(
        preview().locator('img[src*="backgrounds/office.png"]'),
      ).toBeVisible();
    },
  );

  item("caption-edit", "editing a caption updates the Player", async () => {
    await sceneItems().first().click();
    await page.getByLabel("Caption").fill(CAPTION_EDIT);
    await expectEditorClean();
    await expectPreviewCaption(CAPTION_EDIT);
    await expect(sceneItems().first()).toContainText(CAPTION_EDIT);
  });

  item("pose-change", "choosing another pose updates the Player", async () => {
    const catalog = page.getByRole("region", {name: "Available assets"});
    const coffee = catalog.getByRole("button", {name: /Coffee/});

    await coffee.click();
    await expect(coffee).toHaveAttribute("aria-pressed", "true");
    await expectEditorClean();
    await expect(
      preview().locator('img[src*="characters/tora/coffee.png"]'),
    ).toBeVisible();
    await expect(
      preview().locator('img[src*="characters/tora/formal.png"]'),
    ).toHaveCount(0);
  });

  item("scene-reorder", "moving a scene reorders the Story and the Player", async () => {
    await page.getByRole("button", {name: "Move scene down"}).click();
    await expectEditorClean();
    await expect(sceneItems()).toHaveCount(4);
    await expect(sceneItems().nth(0)).toContainText("Pero es solo un cambio");
    await expect(sceneItems().nth(1)).toContainText(CAPTION_EDIT);

    // The Player now opens on what used to be scene 2.
    await expectPreviewCaption(SECOND_CAPTION);
    await expect(
      preview().locator('img[src*="characters/tora/confused.png"]'),
    ).toBeVisible();
  });

  item(
    "player-follows-active-story",
    "the Player shows the Active Story: an invalid draft does not replace it",
    async () => {
      await expect(page.locator("#preview-heading")).toHaveText(
        "Deploy Friday",
      );

      await sceneItems().nth(1).click();

      const caption = page.getByLabel("Caption");

      await expect(caption).toHaveValue(CAPTION_EDIT);
      await caption.fill("");
      await expect(shell()).toHaveAttribute(
        "data-visual-state",
        "schema-invalid",
      );
      await expect(shell()).toHaveAttribute("data-visual-pending", "true");
      await expectPreviewCaption(SECOND_CAPTION);

      await caption.fill(CAPTION_EDIT);
      await expectEditorClean();
      await expectPreviewCaption(SECOND_CAPTION);
    },
  );

  item("yaml-export", "Export active Story YAML downloads the edited Story", async () => {
    const {filename, text} = await downloadActiveYaml();
    const story = parseYaml(text);

    expect(filename).toBe("Deploy-Friday.yaml");
    expect(story.title).toBe("Deploy Friday");
    expect(story.scenes).toHaveLength(4);
    expect(story.scenes.map((scene) => scene.text)).toEqual([
      SECOND_CAPTION,
      CAPTION_EDIT,
      "Se cayó el sistema!",
      "Era un cambio pequeño.",
    ]);
    expect(story.scenes.map((scene) => scene.pose)).toEqual([
      "confused",
      "coffee",
      "panic",
      "coffee",
    ]);
    exportedYaml = text;
  });

  item("reload-restores-edits", "a reload restores the edited Story", async () => {
    expect(exportedYaml, "the yaml-export item must have run").not.toBeNull();

    await page.reload({waitUntil: "domcontentloaded"});
    await waitForOwner(page);
    await mutePlayer();

    await expect(page.locator("#preview-heading")).toHaveText("Deploy Friday");
    await expect(sceneItems()).toHaveCount(4);
    await expect(sceneItems().nth(0)).toContainText("Pero es solo un cambio");
    await expect(sceneItems().nth(1)).toContainText(CAPTION_EDIT);
    await expectPreviewCaption(SECOND_CAPTION);

    expect((await downloadActiveYaml()).text).toBe(exportedYaml);
  });

  item("render-capability-ready", "browser MP4 rendering reports ready", async () => {
    expect(
      await isBrowserRenderSupported(page),
      "Browser MP4 rendering must be ready in system Chrome",
    ).toBe(true);
    await expect(page.locator(".render-banner")).toContainText(
      "Browser MP4 rendering is ready.",
    );
    await expect(renderButton()).toBeEnabled();
  });

  item(
    "pending-draft-blocks-render",
    "a pending visual or YAML draft blocks rendering until it is resolved",
    async () => {
      // A pending visual draft.
      const caption = page.getByLabel("Caption");

      await sceneItems().nth(1).click();
      await caption.fill("");
      await expect(shell()).toHaveAttribute("data-render-blocked", "true");
      await expect(renderButton()).toBeDisabled();
      await expect(page.locator(".render-banner")).toContainText(
        "Resolve or discard pending editor/import work",
      );

      await caption.fill(CAPTION_EDIT);
      await expect(shell()).toHaveAttribute("data-render-blocked", "false");
      await expect(renderButton()).toBeEnabled();

      // A pending YAML draft: edited in the editor, not applied.
      await page.getByRole("button", {name: "Open YAML"}).click();

      const yaml = page.getByLabel("YAML source");
      const original = await yaml.inputValue();

      await yaml.fill(original.replace(CAPTION_EDIT, "Unapplied YAML draft"));
      await expect(shell()).toHaveAttribute("data-render-blocked", "true");
      await expect(renderButton()).toBeDisabled();

      // Restoring the applied source resolves it.
      await yaml.fill(original);
      await expect(page.locator("[data-yaml-dirty=false]")).toBeVisible();
      await expect(shell()).toHaveAttribute("data-render-blocked", "false");
      await expect(renderButton()).toBeEnabled();
      await page.getByRole("button", {name: "Open visual editor"}).click();
      await expect(page.getByLabel("Caption")).toBeVisible();
      await expectPreviewCaption(SECOND_CAPTION);
    },
  );

  item(
    "render-locks-authoring",
    "an in-flight render locks authoring until it settles",
    async () => {
      const downloadPromise = page.waitForEvent("download", {
        timeout: RENDER_TIMEOUT_MS,
      });

      await startRender();

      await expect(shell()).toHaveAttribute("data-authoring-locked", "true");
      await expect(page.getByLabel("Caption")).toBeDisabled();
      await expect(page.getByRole("button", {name: "Open YAML"})).toBeDisabled();
      await expect(
        page.getByRole("button", {name: "Reset project"}),
      ).toBeDisabled();
      await expect(renderButton()).toBeDisabled();
      await expect(
        page.getByRole("button", {name: "Cancel Render"}),
      ).toBeVisible();

      const download = await downloadPromise;

      renderedMp4 = {
        filename: download.suggestedFilename(),
        path: await download.path(),
      };

      await expect(shell()).toHaveAttribute("data-render-state", "success", {
        timeout: 30_000,
      });
      await expect(shell()).toHaveAttribute("data-authoring-locked", "false");
      await expect(page.getByLabel("Caption")).toBeEnabled();
      await expect(page.getByRole("button", {name: "Open YAML"})).toBeEnabled();
    },
    {timeout: 300_000},
  );

  item(
    "render-download-metadata",
    "the downloaded MP4 is video-only H.264, 1080x1920, 30 FPS, 360 frames / 12 s",
    async () => {
      expect(renderedMp4, "the render item must have run").not.toBeNull();
      expect(renderedMp4.filename).toBe("Deploy-Friday.mp4");

      const info = await probeMp4(renderedMp4.path);

      expect(info.codec).toBe("h264");
      expect(info.width).toBe(1080);
      expect(info.height).toBe(1920);
      expect(info.fps).toBeCloseTo(30, 1);
      expect(info.frames).toBe(360);
      expect(info.durationSeconds).toBeCloseTo(12, 1);
      expect(info.hasAudio).toBe(false);

      // Positive control that the frames are not black, and that the edited
      // order was rendered (scene 1 and scene 4 look different).
      const first = await decodeMp4Frame(renderedMp4.path, 1.5);
      const last = await decodeMp4Frame(renderedMp4.path, 10.5);

      expect(meanLuminance(first)).toBeGreaterThan(20);
      expect(meanLuminance(last)).toBeGreaterThan(20);

      let difference = 0;

      for (let index = 0; index < first.length; index += 3) {
        difference += Math.abs(first[index] - last[index]);
      }

      expect(difference / (first.length / 3)).toBeGreaterThan(5);
    },
  );

  item(
    "cancel-render",
    "Cancel Render aborts the render and unlocks authoring",
    async () => {
      let downloaded = false;

      page.on("download", () => {
        downloaded = true;
      });

      await startRender();
      await expect(shell()).toHaveAttribute("data-authoring-locked", "true");
      await page.getByRole("button", {name: "Cancel Render"}).click();
      await expect(shell()).toHaveAttribute("data-render-state", "cancelling");
      await expect
        .poll(() => shell().getAttribute("data-render-state"), {
          timeout: 90_000,
        })
        .not.toMatch(/^(?:rendering|cancelling)$/);
      await expect(shell()).toHaveAttribute("data-authoring-locked", "false");
      await expect(page.getByLabel("Caption")).toBeEnabled();
      expect(downloaded).toBe(false);

      // Settled means "idle" (cancelled cleanly) or "cleanup-blocked" (the
      // render's storage is still being released, the app's own designed
      // state, as the existing Cancel Render spec accepts). Anything else,
      // such as "success" or "failure", is wrong.
      expect(["idle", "cleanup-blocked"]).toContain(
        await shell().getAttribute("data-render-state"),
      );
    },
    {timeout: 180_000},
  );

  item(
    "network-guard",
    "no forbidden request: no uploads, no image bytes, only allowlisted telemetry",
    async () => {
      expect(guard.violations()).toEqual([]);
    },
  );
});
