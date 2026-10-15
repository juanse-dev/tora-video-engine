import {expect, test} from "@playwright/test";
import {fixtureBytes} from "../helpers/audioBytes.mjs";
import {yamlSource} from "./helpers/localAssetFlows.mjs";
import {applyYaml, waitForOwner} from "./helpers/localAssetPage.mjs";

// The built bundle is served; the Player is the real one (muted start, arming).
test.use({viewport: {width: 1400, height: 1500}});

const SECTION = "[data-my-audio]";
const music = (page) => page.getByRole("combobox", {name: "Music", exact: true});
const sfx = (page) => page.getByRole("combobox", {name: "Sound effect", exact: true});
const voice = (page) => page.getByRole("combobox", {name: "Voice", exact: true});
const autoBox = (page) => page.getByLabel("Auto (from voice)");
const importInput = (page) => page.locator(`${SECTION} .my-assets-toolbar input[type="file"]`);
const upload = (name) => ({name, mimeType: "application/octet-stream", buffer: Buffer.from(fixtureBytes(name))});
const appShell = (page) => page.locator(".app-shell");

const openApp = async (page) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
};

/** Imports the 2.2 s voice fixture and waits until its card is listed. */
const importVoiceFixture = async (page) => {
  await importInput(page).setInputFiles(upload("tone-440-2.2s.wav"));
  await expect(page.locator(`${SECTION} [data-local-asset-card]`)).toHaveCount(1);
};

const twoSceneYaml = [
  "title: Audio fields",
  "scenes:",
  "  - type: intro",
  "    pose: formal",
  "    background: office",
  "    text: One",
  "    duration: 3",
  "  - type: dialogue",
  "    pose: formal",
  "    background: office",
  "    text: Two",
  "    duration: 4",
  "",
].join("\n");

test("the Music panel writes minimal canonical YAML and None removes the music", async ({page}) => {
  await openApp(page);

  // Bundled effects are offered; the music files are not supplied yet, so no music entry exists.
  await expect(music(page).locator("option")).toHaveText(["None", "Whoosh", "Boom", "Ding", "Pop"]);
  await expect(page.getByLabel("Music volume")).toHaveCount(0);

  await music(page).selectOption("ding");
  await expect(page.getByLabel("Music volume")).toHaveValue("1");
  await expect(page.getByLabel("Music ducking")).toHaveValue("0.35");
  await expect(appShell(page)).toHaveAttribute("data-visual-pending", "false");
  expect(await yamlSource(page)).toContain("music:\n  src: ding\nscenes:");

  await page.getByLabel("Music volume").fill("0.6");
  await page.getByLabel("Music ducking").fill("0.5");
  await page.getByLabel("Fade in (seconds)").fill("0.5");
  await page.getByLabel("Fade out (seconds)").fill("1.5");
  await expect(appShell(page)).toHaveAttribute("data-visual-pending", "false");
  expect(await yamlSource(page)).toContain(
    "music:\n  src: ding\n  volume: 0.6\n  fadeIn: 0.5\n  fadeOut: 1.5\n  duck: 0.5\n",
  );

  // Values equal to their defaults leave the Story again.
  await page.getByLabel("Music volume").fill("1");
  await page.getByLabel("Music ducking").fill("0.35");
  await page.getByLabel("Fade in (seconds)").fill("0");
  await page.getByLabel("Fade out (seconds)").fill("0");
  expect(await yamlSource(page)).toContain("music:\n  src: ding\nscenes:");

  await music(page).selectOption("");
  await expect(page.getByLabel("Music volume")).toHaveCount(0);
  expect(await yamlSource(page)).not.toContain("music:");
});

test("an out-of-range fade keeps a pending draft with its error until it is fixed", async ({page}) => {
  await openApp(page);
  await music(page).selectOption("ding");
  await page.getByLabel("Fade in (seconds)").fill("11");
  await expect(appShell(page)).toHaveAttribute("data-visual-pending", "true");
  await expect(page.locator(".music-panel .field-error")).toHaveCount(1);
  await page.getByLabel("Fade in (seconds)").fill("2");
  await expect(appShell(page)).toHaveAttribute("data-visual-pending", "false");
  await expect(page.locator(".music-panel .field-error")).toHaveCount(0);
});

test("a scene's Sound effect and Voice selects write the Story and keep a volume across a change of sound", async ({page}) => {
  await openApp(page);
  await applyYaml(page, twoSceneYaml);
  await page.getByRole("button", {name: "Open visual editor"}).click();

  await sfx(page).selectOption("ding");
  await page.getByLabel("Sound effect volume").fill("0.8");
  await sfx(page).selectOption("boom");
  await expect(page.getByLabel("Sound effect volume")).toHaveValue("0.8");
  await page.locator(".scene-list-item").nth(1).click();
  await expect(sfx(page)).toHaveValue("");
  await expect(page.getByLabel("Sound effect volume")).toHaveCount(0);

  expect(await yamlSource(page)).toContain(
    "    text: One\n    sfx:\n      src: boom\n      volume: 0.8\n    duration: 3\n",
  );

  await page.locator(".scene-list-item").nth(0).click();
  await sfx(page).selectOption("");
  expect(await yamlSource(page)).not.toContain("sfx:");
});

test("Auto (from voice) needs a voice, shows the resolved seconds and Voice None gives the number back in one edit", async ({page}) => {
  await openApp(page);
  await applyYaml(page, twoSceneYaml);
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await importVoiceFixture(page);

  await expect(autoBox(page)).toBeDisabled();
  await expect(autoBox(page)).not.toBeChecked();

  await voice(page).selectOption({label: "tone-440-2.2s"});
  await expect(autoBox(page)).toBeEnabled();
  await autoBox(page).check();

  const duration = page.locator("label.field").filter({hasText: "Duration (seconds)"});

  await expect(duration.locator("output")).toHaveText("auto · 2.7 s");
  await expect(page.getByRole("spinbutton")).toHaveCount(0);
  await expect(appShell(page)).toHaveAttribute("data-visual-pending", "false");

  // Unchecking restores the number the scene had (3 s).
  await autoBox(page).uncheck();
  await expect(page.getByLabel("Duration (seconds)")).toHaveValue("3");
  await autoBox(page).check();
  await expect(duration.locator("output")).toHaveText("auto · 2.7 s");

  // Voice None on an auto scene: one valid edit, no pending draft, the number is back.
  await voice(page).selectOption("");
  await expect(appShell(page)).toHaveAttribute("data-visual-pending", "false");
  await expect(autoBox(page)).toBeDisabled();
  await expect(autoBox(page)).not.toBeChecked();
  await expect(page.getByLabel("Duration (seconds)")).toHaveValue("3");

  const source = await yamlSource(page);

  expect(source).toContain("duration: 3");
  expect(source).not.toContain("voice:");
  expect(source).not.toContain("duration: auto");
});

test("Auto (from voice) is written as duration: auto, and after a round trip through YAML unchecking uses the resolved seconds", async ({page}) => {
  await openApp(page);
  await applyYaml(page, twoSceneYaml);
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await importVoiceFixture(page);
  await voice(page).selectOption({label: "tone-440-2.2s"});
  await autoBox(page).check();
  await expect(appShell(page)).toHaveAttribute("data-visual-pending", "false");
  expect(await yamlSource(page)).toContain("    duration: auto\n");

  // Opening YAML rebuilt the draft from the Story: the remembered 3 s is gone.
  await expect(autoBox(page)).toBeChecked();
  await autoBox(page).uncheck();
  await expect(page.getByLabel("Duration (seconds)")).toHaveValue("2.7");
});

test("a voice set through the UI, with a non-default volume, is written to the exported YAML", async ({page}) => {
  await openApp(page);
  await applyYaml(page, twoSceneYaml);
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await importVoiceFixture(page);

  const ref = await page.locator(`${SECTION} [data-local-asset-card]`).getAttribute("data-local-asset-card");

  await voice(page).selectOption({label: "tone-440-2.2s"});
  await expect(page.getByLabel("Voice volume")).toHaveValue("1");
  expect(await yamlSource(page)).toContain(`    voice:
      src: ${ref}
    duration: 3
`);

  await page.getByLabel("Voice volume").fill("0.5");
  await expect(appShell(page)).toHaveAttribute("data-visual-pending", "false");
  expect(await yamlSource(page)).toContain(`    voice:
      src: ${ref}
      volume: 0.5
    duration: 3
`);

  await voice(page).selectOption("");
  expect(await yamlSource(page)).not.toContain("voice:");
});

test("Voice None on an auto scene read from YAML uses the resolved seconds rounded to 0.1 s", async ({page}) => {
  await openApp(page);
  await importVoiceFixture(page);

  const ref = await page.locator(`${SECTION} [data-local-asset-card]`).getAttribute("data-local-asset-card");

  await applyYaml(
    page,
    [
      "title: Auto from YAML",
      "scenes:",
      "  - type: intro",
      "    pose: formal",
      "    background: office",
      "    text: One",
      "    voice:",
      `      src: ${ref}`,
      "    duration: auto",
      "",
    ].join("\n"),
  );
  await page.getByRole("button", {name: "Open visual editor"}).click();

  const duration = page.locator("label.field").filter({hasText: "Duration (seconds)"});

  await expect(duration.locator("output")).toHaveText("auto · 2.7 s");
  await voice(page).selectOption("");
  await expect(appShell(page)).toHaveAttribute("data-visual-pending", "false");
  await expect(page.getByLabel("Duration (seconds)")).toHaveValue("2.7");

  const source = await yamlSource(page);

  expect(source).toContain("duration: 2.7");
  expect(source).not.toContain("voice:");
});

test("a Story value the library no longer offers stays selectable instead of showing another sound", async ({page}) => {
  await openApp(page);

  const ghost = `local:audio:sha256:${"a".repeat(64)}`;

  await applyYaml(
    page,
    [
      "title: Ghost",
      "music:",
      "  src: calm-loop",
      "scenes:",
      "  - type: intro",
      "    pose: formal",
      "    background: office",
      "    text: One",
      "    sfx:",
      `      src: ${ghost}`,
      "    duration: 3",
      "",
    ].join("\n"),
  );
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await expect(music(page)).toHaveValue("calm-loop");
  await expect(music(page).locator("option:checked")).toHaveText("Calm loop (not available)");
  await expect(sfx(page)).toHaveValue(ghost);
  await expect(sfx(page).locator("option:checked")).toHaveText("Missing audio aaaa…aaaa");
});

test("while authoring is locked every audio control is disabled", async ({page}) => {
  await page.addInitScript(() => {
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
  await openApp(page);
  await applyYaml(
    page,
    [
      "title: Locked",
      "music:",
      "  src: ding",
      "scenes:",
      "  - type: intro",
      "    pose: formal",
      "    background: office",
      "    text: One",
      "    sfx:",
      "      src: boom",
      "    voice:",
      "      src: pop",
      "    duration: 3",
      "",
    ].join("\n"),
  );
  await page.getByRole("button", {name: "Open visual editor"}).click();

  const controls = [
    music(page),
    page.getByLabel("Music volume"),
    page.getByLabel("Music ducking"),
    page.getByLabel("Fade in (seconds)"),
    page.getByLabel("Fade out (seconds)"),
    sfx(page),
    page.getByLabel("Sound effect volume"),
    voice(page),
    page.getByLabel("Voice volume"),
    autoBox(page),
  ];

  // Positive control: enabled before the lock.
  for (const control of controls) {
    await expect(control).toBeEnabled();
  }

  await page.evaluate(() => {
    window.__holdDigest = true;
  });
  await importInput(page).setInputFiles(upload("tone-440-2.2s.wav"));
  await expect.poll(() => page.evaluate(() => window.__heldDigests)).toBeGreaterThan(0);
  await expect(appShell(page)).toHaveAttribute("data-authoring-locked", "true");

  for (const control of controls) {
    await expect(control).toBeDisabled();
  }

  await page.evaluate(() => window.__releaseDigest());
  await expect(appShell(page)).toHaveAttribute("data-authoring-locked", "false");

  for (const control of controls) {
    await expect(control).toBeEnabled();
  }
});
