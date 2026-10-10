import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {expect, test} from "@playwright/test";
import {
  blobImages,
  cardFor,
  exportActiveYaml,
  fixtureUpload,
  importInput,
  localRefsIn,
  missingCard,
  previewPlaceholders,
  renderBanner,
  section,
  statusLine,
} from "../browser/helpers/localAssetFlows.mjs";
import {
  localAssetRef,
  readFixture,
} from "../browser/helpers/seedAssetLibrary.mjs";
import {
  chromeVersion,
  expectFreshBlobUrls,
  expectLocalAssetFrames,
  expectLocalAssetsRestored,
  expectMp4Metadata,
  expectNoImportInThisPage,
  expectSameProfile,
  launchGateProfile,
  markProfile,
  mutePlayer,
  openApp,
  readYaml,
  renderAndSave,
  settledEnvelope,
  STORAGE_KEY,
} from "./helpers/gateApp.mjs";
import {readPageBuildIdentity} from "./helpers/buildIdentity.mjs";
import {renderWithCli} from "./helpers/cliParity.mjs";
import {
  assertNewBuild,
  mergePhase,
  readGateEnv,
  readState,
  recordResult,
  statePaths,
} from "./helpers/gateState.mjs";
import {
  attachNetworkGuard,
  combineGuards,
  saveNetworkLog,
  summarizeNetwork,
} from "./helpers/networkGuard.mjs";

// GATE-001 T2: ASSET-006 Part B steps 2-13 against a deployed origin, in a
// dedicated system-Chrome profile (G4/G5), with the network guard on (G6).
// One serial test per phase. Phase A: a v0.2 envelope, import, reload, browser
// restart, export, render, CLI parity. Phase B: the same profile on the new
// build, delete -> Import matching file, render again.
//
// Each step records its outcome for the report rows (see report.mjs):
// reload (steps 2-9), deleteReimport (10-11), noUpload (12), cliParity (13).

const gate = readGateEnv();
const paths = statePaths(gate.stateDir);
const FIXTURE_DIR = new URL("../fixtures/local-assets/", import.meta.url);
const V02_ENVELOPE = new URL(
  "../fixtures/v0.2/project-envelope.json",
  import.meta.url,
);
const CI_STORY = new URL("../../stories/ci-local-assets.yaml", import.meta.url);
// Short on purpose: a caption of three lines reaches into the background colour region.
const EDITED_CAPTION = "Gate edit";

const firstLines = (error) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/\u001b\[[0-9;]*m/gu, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");

/** A test.step whose failure is recorded under the report row `key`. */
const gateStep = (key, name, run) =>
  test.step(name, async () => {
    try {
      return await run();
    } catch (error) {
      await recordResult(gate.stateDir, key, {
        status: "fail",
        detail: `${name}: ${firstLines(error)}`,
      });
      throw error;
    }
  });

const sessionSetup = async () => {
  const pose = await readFixture("pose-magenta.png");
  const background = await readFixture("background-cyan.jpg");
  const refs = {
    pose: localAssetRef("pose", pose.digest),
    background: localAssetRef("background", background.digest),
  };
  const guards = [];
  const all = combineGuards(guards);
  let session = null;

  const open = async (profileDir = paths.profileDir) => {
    session = await launchGateProfile({
      profileDir,
      baseURL: gate.url,
      headed: gate.headed,
    });
    guards.push(
      attachNetworkGuard(session.context, {
        fixtureBuffers: [
          Buffer.from(pose.bytes),
          Buffer.from(background.bytes),
        ],
      }),
    );

    return session;
  };
  const close = async () => {
    const current = session;

    session = null;
    await current?.context.close();
  };

  return {
    pose,
    background,
    refs,
    guards,
    all,
    open,
    close,
    current: () => session,
  };
};

/** Always saves the network log; records noUpload with each violation before the caller fails. */
const finishNetwork = async (setup, label, phase) => {
  await saveNetworkLog(paths.networkPath, label, setup.all);

  const violations = setup.all.violations();

  if (violations.length > 0) {
    await recordResult(gate.stateDir, "noUpload", {
      status: "fail",
      detail: `Network guard: ${violations.length} violation(s): ${violations.join("; ")}`,
      phase,
    });
  }

  return violations;
};

// --- phase A ---------------------------------------------------------------

const phaseA = async () => {
  const setup = await sessionSetup();
  const {pose, background, refs} = setup;
  const artifact = (name) => join(paths.artifactsDir, name);
  const ciRefs = localRefsIn(await readFile(CI_STORY, "utf8"));
  const envelopeRaw = await readFile(V02_ENVELOPE, "utf8");
  const envelope = JSON.parse(envelopeRaw);
  let token;
  let imported;
  let exportedYamlPath;
  let browserInfo;
  let failed = false;

  try {
    await gateStep(
      "reload",
      "step 2: v0.2 envelope restores and stays version 1",
      async () => {
        token = await markProfile(paths.profileDir);

        const {page} = await setup.open();

        expect(envelope.version).toBe(1);
        await openApp(page);
        // A fresh profile has no project yet; store the v0.2 envelope, reload.
        await page.evaluate(
          ([key, value]) => localStorage.setItem(key, value),
          [STORAGE_KEY, envelopeRaw],
        );
        await page.reload({waitUntil: "domcontentloaded"});
        await mutePlayer(page);

        // The Story from the envelope is active: title, scene count, caption.
        const scenes = envelope.story.scenes;

        await expect(page.locator(".recovery-banner")).toHaveCount(0);
        await expect(page.getByText(`Scenes (${scenes.length})`)).toBeVisible();
        await expect(page.locator(".scene-list-item")).toHaveCount(
          scenes.length,
        );
        await expect(page.getByLabel("Caption")).toHaveValue(scenes[0].text);
        expect(await readYaml(page)).toMatch(
          new RegExp(`^title: "?${envelope.story.title}"?$`, "mu"),
        );
        // Restoring did not rewrite the stored bytes.
        expect(
          await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY),
        ).toBe(envelopeRaw);
        // The Player renders the Story.
        await expect(
          page.locator(".preview-frame [data-caption-line]").first(),
        ).toBeVisible();
        await expect
          .poll(() =>
            page
              .locator(".preview-frame [data-caption-line]")
              .allTextContents()
              .then((lines) => lines.join(" ")),
          )
          .toBe(scenes[0].text);

        // One bundled edit keeps the envelope at version 1 with no local refs.
        await page.getByLabel("Caption").fill(EDITED_CAPTION);
        await expect
          .poll(
            async () =>
              await page.evaluate(
                (key) => localStorage.getItem(key) ?? "",
                STORAGE_KEY,
              ),
          )
          .toContain(EDITED_CAPTION);

        const {raw, envelope: stored} = await settledEnvelope(page, 1);

        expect(localRefsIn(raw)).toEqual([]);
        expect(stored.story.scenes[0].text).toBe(EDITED_CAPTION);
        browserInfo = {name: "Chrome", version: await chromeVersion(page)};
      },
    );

    await gateStep(
      "reload",
      "steps 3-4: import and apply both fixtures through My assets",
      async () => {
        const {page} = setup.current();

        await importInput(page, "pose").setInputFiles(fixtureUpload(pose));
        await expect(statusLine(page, "pose")).toHaveText(
          'Imported "pose-magenta".',
        );
        await importInput(page, "background").setInputFiles(
          fixtureUpload(background),
        );
        await expect(statusLine(page, "background")).toHaveText(
          'Imported "background-cyan".',
        );

        // The refs in the YAML editor are the fixtures' digests, which are the
        // ones stories/ci-local-assets.yaml (the CLI's Story) uses.
        const yaml = await readYaml(page);

        expect([
          yaml.match(/pose: (local:pose:sha256:[0-9a-f]{64})/u)?.[1],
          yaml.match(
            /background: (local:background:sha256:[0-9a-f]{64})/u,
          )?.[1],
        ]).toEqual(ciRefs);
        expect(ciRefs).toEqual([refs.pose, refs.background]);

        imported = await expectLocalAssetsRestored(page, refs);

        // My assets is separate from Bundled, which is unchanged.
        await expect(page.getByRole("heading", {name: "Bundled"})).toHaveCount(
          2,
        );
        const bundledPoses = page.locator(".pose-grid").first();

        await expect(bundledPoses.locator("button.asset-card")).toHaveCount(4);
        await expect(
          bundledPoses.locator("[data-local-asset-card]"),
        ).toHaveCount(0);

        const {raw, envelope: stored} = await settledEnvelope(page, 2);

        expect(raw).not.toContain("blob:");
        expect(JSON.stringify(stored.story)).toContain(refs.pose);
        expect(JSON.stringify(stored.story)).toContain(refs.background);
      },
    );

    await gateStep(
      "reload",
      "step 5: reload recovers Story, cards and Player without re-import",
      async () => {
        const {page} = setup.current();

        await page.reload({waitUntil: "domcontentloaded"});
        await mutePlayer(page);

        const restored = await expectLocalAssetsRestored(page, refs);

        await expectNoImportInThisPage(page);
        expectFreshBlobUrls(imported, restored);
        await settledEnvelope(page, 2);
        imported = restored;
      },
    );

    await gateStep(
      "reload",
      "step 6: closing and relaunching the same profile recovers everything",
      async () => {
        await setup.close();

        // Same directory (marker + Chrome's own profile), new browser process.
        await expectSameProfile(paths.profileDir, token);

        const {page} = await setup.open();

        await openApp(page);
        await mutePlayer(page);

        const restored = await expectLocalAssetsRestored(page, refs);

        await expectNoImportInThisPage(page);
        expectFreshBlobUrls(imported, restored);
        await settledEnvelope(page, 2);
        imported = restored;
      },
    );

    await gateStep(
      "reload",
      "step 7: exported YAML carries the refs and no bytes, blob:, data: or paths",
      async () => {
        const {page} = setup.current();
        const {text} = await exportActiveYaml(page);

        expect(localRefsIn(text)).toEqual([refs.pose, refs.background]);
        expect(text).not.toMatch(/blob:|data:|file:|\\|[A-Za-z]:[\\/]/iu);
        expect(text).not.toMatch(/[A-Za-z0-9+/=]{100,}/u);
        expect(text).not.toContain("pose-magenta");
        expect(text).not.toContain("background-cyan");
        exportedYamlPath = artifact("exported-story.yaml");
        await writeFile(exportedYamlPath, text);
      },
    );

    let browserMp4;

    await gateStep(
      "reload",
      "step 8: browser MP4 render and download",
      async () => {
        const {page} = setup.current();

        browserMp4 = await renderAndSave(
          page,
          artifact("browser-render-A.mp4"),
        );
        await expectMp4Metadata(browserMp4);
        await expectLocalAssetFrames(browserMp4);
      },
    );

    await gateStep(
      "cliParity",
      "step 13: npm run video renders the same images from the exported YAML",
      async () => {
        const cliMp4 = await renderWithCli({
          yamlPath: exportedYamlPath,
          fixtures: {
            poses: [fileURLToPath(new URL("pose-magenta.png", FIXTURE_DIR))],
            backgrounds: [
              fileURLToPath(new URL("background-cyan.jpg", FIXTURE_DIR)),
            ],
          },
          outDir: paths.artifactsDir,
        });

        const info = await expectMp4Metadata(cliMp4);

        await expectLocalAssetFrames(cliMp4);
        expect(info.frames).toBe(360);
        await recordResult(gate.stateDir, "cliParity", {
          status: "pass",
          detail: `npm run video on the exported YAML with the two fixtures in a local-assets-style folder (TORA_LOCAL_ASSETS_ROOT) rendered ${info.frames} frames (${info.codec}, ${info.width}x${info.height}, ${info.fps} FPS); scene 1 shows the same magenta pose and cyan/yellow background as the browser MP4, scene 3 does not`,
          phase: "A",
        });
      },
    );
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await setup.close().catch(() => {});

    const violations = await finishNetwork(setup, "A:gate", "A");

    await mergePhase(gate.stateDir, "A", {
      ...(browserInfo ? {browser: browserInfo} : {}),
      refs,
      profileMarker: token,
      networkSummary: summarizeNetwork(setup.all),
    });

    if (!failed) {
      expect(violations).toEqual([]);
    }
  }

  const reloadDetailA = `Phase A pass. The v0.2 envelope (version 1) restored and kept version 1 after a bundled caption edit; importing both fixtures through My assets made it version 2; reload and a full browser relaunch of the same profile kept Story, My assets and Player without re-import (blob: URLs rebuilt); the exported YAML has only the two refs; the browser MP4 (H.264, 1080x1920, 30 FPS, 360 frames, video only) shows the magenta pose and cyan/yellow background in scene 1. Deploy B pending.`;

  // Kept in state so a phase B rerun can still compose the final row.
  await mergePhase(gate.stateDir, "A", {reloadDetail: reloadDetailA});
  await recordResult(gate.stateDir, "reload", {
    status: "pending",
    detail: reloadDetailA,
    phase: "A",
  });
  await recordResult(gate.stateDir, "noUpload", {
    status: "pending",
    detail: `Phase A: ${summarizeNetwork(setup.all)}. Phase B pending.`,
    phase: "A",
  });
};

// --- phase B ---------------------------------------------------------------

const phaseB = async () => {
  const setup = await sessionSetup();
  const {pose, background, refs} = setup;
  const state = await readState(gate.stateDir);
  const artifact = (name) => join(paths.artifactsDir, name);
  let failed = false;

  try {
    await gateStep(
      "reload",
      "step 9: Deploy B is live and the same profile still has everything",
      async () => {
        await expectSameProfile(paths.profileDir, state.a.profileMarker);

        const {page} = await setup.open();

        await openApp(page);

        const identity = await readPageBuildIdentity(page);

        await mergePhase(gate.stateDir, "B", {
          identity,
          browser: {name: "Chrome", version: await chromeVersion(page)},
        });
        assertNewBuild(state, identity);

        await mutePlayer(page);

        // Assets are there with no import in this page.
        const restored = await expectLocalAssetsRestored(page, refs);

        await expectNoImportInThisPage(page);
        expect(restored.preview.length).toBe(2);
        await settledEnvelope(page, 2);

        const mp4 = await renderAndSave(page, artifact("browser-render-B.mp4"));

        await expectMp4Metadata(mp4);
        await expectLocalAssetFrames(mp4);
      },
    );

    const yamlBefore = await readYaml(setup.current().page);

    await gateStep(
      "deleteReimport",
      "step 10: deleting the in-use pose warns, then shows the missing state",
      async () => {
        const {page} = setup.current();
        const dialog = page.getByRole("dialog");

        await cardFor(page, "pose", pose.digest)
          .getByRole("button", {name: /^Delete /u})
          .click();
        await expect(dialog).toContainText("is used by 1 scene in this Story");
        await expect(dialog.getByRole("button")).toHaveText([
          "Cancel",
          "Delete asset anyway",
        ]);
        await dialog.getByRole("button", {name: "Delete asset anyway"}).click();
        await expect(dialog).toHaveCount(0);

        await expect(cardFor(page, "pose", pose.digest)).toHaveCount(0);
        await expect(missingCard(page, refs.pose)).toContainText(
          "Missing local pose",
        );
        await expect(previewPlaceholders(page)).toHaveCount(1);
        // The background is still local, so exactly its image remains.
        await expect(blobImages(page)).toHaveCount(1);
        await expect(
          page.getByRole("button", {name: "Render MP4"}),
        ).toBeDisabled();
        await expect(renderBanner(page)).toHaveAttribute(
          "data-local-asset-block",
          /local asset\(s\) are unavailable/u,
        );
        expect(await readYaml(page)).toBe(yamlBefore);
      },
    );

    await gateStep(
      "deleteReimport",
      "step 11: Import matching file resolves it and render succeeds",
      async () => {
        const {page} = setup.current();

        await missingCard(page, refs.pose)
          .locator('input[type="file"]')
          .setInputFiles(fixtureUpload(pose));
        await expect(statusLine(page, "pose")).toHaveText(
          'Imported "pose-magenta".',
        );
        await expect(missingCard(page, refs.pose)).toHaveCount(0);
        await expect(cardFor(page, "pose", pose.digest)).toContainText(
          "Current",
        );
        await expect(previewPlaceholders(page)).toHaveCount(0);
        expect(await readYaml(page)).toBe(yamlBefore);
        await expectLocalAssetsRestored(page, refs);

        const mp4 = await renderAndSave(
          page,
          artifact("browser-render-B-reimport.mp4"),
        );

        await expectMp4Metadata(mp4);
        await expectLocalAssetFrames(mp4);
      },
    );
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await setup.close().catch(() => {});

    const violations = await finishNetwork(setup, "B:gate", "B");

    if (!failed) {
      expect(violations).toEqual([]);
    }
  }

  await recordResult(gate.stateDir, "deleteReimport", {
    status: "pass",
    detail: `Deleting the pose warned "used by 1 scene"; scene 1 showed the missing placeholder, the missing recovery card and a blocked Render MP4, with the Story YAML unchanged; Import matching file with the same fixture resolved it without a Story change and the render succeeded (H.264, 1080x1920, 30 FPS, 360 frames).`,
    phase: "B",
  });

  await recordResult(gate.stateDir, "reload", {
    status: "pass",
    detail: `${state.a.reloadDetail.replace(/ Deploy B pending\.$/u, "")} Deploy B (a different build on the same origin, same profile): Story, My assets and Player came back without re-import and the render after Deploy B succeeded.`,
    phase: "B",
  });
  await recordResult(gate.stateDir, "noUpload", {
    status: "pass",
    detail: `No request carried image bytes. Phase A: ${state.a.networkSummary}. Phase B: ${summarizeNetwork(setup.all)}.`,
    phase: "B",
  });
};

test(`phase ${gate.phase}: ASSET-006 Part B on the deployed origin`, async () => {
  try {
    await (gate.phase === "A" ? phaseA() : phaseB());
  } catch (error) {
    // A step already recorded its own failure; this covers anything outside
    // the steps (launching Chrome, for example) so the report still lists it.
    const {results} = await readState(gate.stateDir);

    if (!Object.values(results).some((result) => result.status === "fail")) {
      await recordResult(gate.stateDir, "gate", {
        status: "fail",
        detail: firstLines(error),
      });
    }

    throw error;
  }
});
