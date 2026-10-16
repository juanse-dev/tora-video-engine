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

// ---------------------------------------------------------------------------
// My audio cards: waveform thumbnail, preview, single-preview rule (AUDIO-004 task 3)
// ---------------------------------------------------------------------------

const card = (page, label) =>
  page.locator(`${SECTION} [data-local-asset-card]`).filter({hasText: label});
const playButton = (page, label) => page.getByRole("button", {name: `Play ${label}`, exact: true});
const stopButton = (page, label) => page.getByRole("button", {name: `Stop ${label}`, exact: true});
const trackPlayedAudio = (page) =>
  page.addInitScript(() => {
    window.__played = [];

    const original = HTMLMediaElement.prototype.play;

    HTMLMediaElement.prototype.play = function play(...args) {
      if (this.src.startsWith("blob:")) {
        window.__played.push(this);
      }

      return original.apply(this, args);
    };
  });
const soundingPreviews = (page) =>
  page.evaluate(
    () => new Set(window.__played.filter((element) => !element.paused && !element.ended)).size,
  );

test("a card draws its waveform from the stored peaks", async ({page}) => {
  await openApp(page);
  await importInput(page).setInputFiles(upload("tone-440-2.2s.wav"));

  const canvas = card(page, "tone-440-2.2s").locator("canvas[data-waveform-thumbnail]");

  await expect(canvas).toHaveCount(1);
  await expect(canvas).toHaveAttribute("aria-hidden", "true");
  // A full-scale tone fills the canvas height: bars cover most of the middle row.
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const {data} = element.getContext("2d").getImageData(0, 0, element.width, element.height);
        let painted = 0;

        for (let index = 3; index < data.length; index += 4) {
          if (data[index] > 0) {
            painted += 1;
          }
        }

        return painted;
      }),
    )
    .toBeGreaterThan(1000);
});

test("Play and Stop toggle one preview on the verified payload, and only one card plays at a time", async ({page}) => {
  await trackPlayedAudio(page);
  await openApp(page);
  await importInput(page).setInputFiles(upload("tone-220-10s.wav"));
  await expect(card(page, "tone-220-10s")).toHaveCount(1);
  await importInput(page).setInputFiles(upload("tone-880-0.4s.wav"));
  await expect(card(page, "tone-880-0.4s")).toHaveCount(1);
  await importInput(page).setInputFiles(upload("tone-220-12s.wav"));
  await expect(card(page, "tone-220-12s")).toHaveCount(1);

  await playButton(page, "tone-220-10s").click();
  await expect(stopButton(page, "tone-220-10s")).toBeVisible();
  await expect.poll(() => soundingPreviews(page)).toBe(1);
  expect(await page.evaluate(() => window.__played[0].src.startsWith("blob:"))).toBe(true);

  // Another card takes over: the first goes back to Play.
  await playButton(page, "tone-220-12s").click();
  await expect(stopButton(page, "tone-220-12s")).toBeVisible();
  await expect(playButton(page, "tone-220-10s")).toBeVisible();
  await expect.poll(() => soundingPreviews(page)).toBe(1);

  await stopButton(page, "tone-220-12s").click();
  await expect(playButton(page, "tone-220-12s")).toBeVisible();
  await expect.poll(() => soundingPreviews(page)).toBe(0);
});

test("starting a preview pauses the Player and starting the Player stops the preview", async ({page}) => {
  await trackPlayedAudio(page);
  await openApp(page);
  await importInput(page).setInputFiles(upload("tone-220-10s.wav"));
  await expect(card(page, "tone-220-10s")).toHaveCount(1);

  const frame = async () => Number(await page.locator(".preview-frame").getAttribute("data-tora-frame"));

  await page.getByRole("button", {name: "Play video"}).click();
  await expect(page.getByRole("button", {name: "Pause video"})).toBeVisible();
  await expect.poll(frame).toBeGreaterThan(2);

  await playButton(page, "tone-220-10s").click();
  await expect(stopButton(page, "tone-220-10s")).toBeVisible();
  await expect(page.getByRole("button", {name: "Play video"})).toBeVisible();

  const paused = await frame();

  await page.waitForTimeout(400);
  expect(await frame()).toBe(paused);
  await expect.poll(() => soundingPreviews(page)).toBe(1);

  await page.getByRole("button", {name: "Play video"}).click();
  await expect(playButton(page, "tone-220-10s")).toBeVisible();
  await expect.poll(() => soundingPreviews(page)).toBe(0);
  await expect.poll(frame).toBeGreaterThan(paused);
});

test("leaving the visual editor (Open YAML unmounts My audio) stops a preview that is playing", async ({page}) => {
  await trackPlayedAudio(page);
  await openApp(page);
  await importInput(page).setInputFiles(upload("tone-220-10s.wav"));
  await playButton(page, "tone-220-10s").click();
  await expect.poll(() => soundingPreviews(page)).toBe(1);

  await page.getByRole("button", {name: "Open YAML"}).click();
  await expect(page.getByLabel("YAML source")).toBeVisible();
  await expect(page.locator(SECTION)).toHaveCount(0);
  await expect.poll(() => soundingPreviews(page)).toBe(0);
});

test("a preview that cannot play says so in a status region that is already on the card", async ({page}) => {
  await trackPlayedAudio(page);
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play;

    // The verified blob: URL is refused; the silent primer (a data: URL) is not.
    HTMLMediaElement.prototype.play = function play(...args) {
      return this.src.startsWith("blob:")
        ? Promise.reject(new DOMException("blocked", "NotAllowedError"))
        : original.apply(this, args);
    };
  });
  await openApp(page);
  await importInput(page).setInputFiles(upload("tone-220-10s.wav"));

  const message = card(page, "tone-220-10s").locator("[data-audio-preview-error]");

  // Mounted before anything fails, and empty.
  await expect(message).toHaveCount(1);
  await expect(message).toHaveAttribute("role", "status");
  await expect(message).toHaveText("");

  await playButton(page, "tone-220-10s").click();
  await expect(message).toHaveText("This audio could not be played.");
  await expect(playButton(page, "tone-220-10s")).toBeVisible();
});

test("deleting the sound that is playing stops it", async ({page}) => {
  await trackPlayedAudio(page);
  await openApp(page);
  await importInput(page).setInputFiles(upload("tone-220-10s.wav"));
  await playButton(page, "tone-220-10s").click();
  await expect.poll(() => soundingPreviews(page)).toBe(1);

  await page.getByRole("button", {name: "Delete tone-220-10s", exact: true}).click();
  await expect.poll(() => soundingPreviews(page)).toBe(0);
  await page.getByRole("dialog").getByRole("button", {name: "Delete asset"}).click();
  await expect(card(page, "tone-220-10s")).toHaveCount(0);
});

test("the preview controls are disabled while authoring is locked, and a preview that is playing is stopped when the lock engages", async ({page}) => {
  await trackPlayedAudio(page);
  await openApp(page);
  await importInput(page).setInputFiles(upload("tone-220-10s.wav"));
  await expect(playButton(page, "tone-220-10s")).toBeEnabled();
  await playButton(page, "tone-220-10s").click();
  await expect.poll(() => soundingPreviews(page)).toBe(1);

  await page.evaluate(() => {
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    window.__heldDigests = 0;
    window.__releaseDigest = () => release();
    crypto.subtle.digest = async (...args) => {
      window.__heldDigests += 1;
      await gate;

      return nativeDigest(...args);
    };
  });
  await importInput(page).setInputFiles(upload("tone-440-2.2s.wav"));
  await expect.poll(() => page.evaluate(() => window.__heldDigests)).toBeGreaterThan(0);
  await expect(appShell(page)).toHaveAttribute("data-authoring-locked", "true");
  await expect(playButton(page, "tone-220-10s")).toBeDisabled();
  // The lock stopped the preview (its Stop button is disabled, so nothing else could).
  await expect.poll(() => soundingPreviews(page)).toBe(0);
  await page.evaluate(() => window.__releaseDigest());
  await expect(appShell(page)).toHaveAttribute("data-authoring-locked", "false");
  await expect(playButton(page, "tone-220-10s")).toBeEnabled();
});

const GHOST = `local:audio:sha256:${"b".repeat(64)}`;
const ghostStoryYaml = [
  "title: Ghost usage",
  "scenes:",
  ...[1, 2].flatMap((number) => [
    "  - type: intro",
    "    pose: formal",
    "    background: office",
    `    text: Scene ${number}`,
    "    voice:",
    `      src: ${GHOST}`,
    "    duration: 3",
  ]),
  "",
].join("\n");

test("a missing card counts the Active Story's usage even while a pending draft has dropped one", async ({page}) => {
  await openApp(page);
  await applyYaml(page, ghostStoryYaml);
  await page.getByRole("button", {name: "Open visual editor"}).click();

  const missing = page.locator(`[data-missing-local-asset-card="${GHOST}"]`);

  await expect(missing).toContainText("Used by scenes 1, 2.");

  // A pending draft: the music fade is out of range, and scene 2 loses its voice.
  await music(page).selectOption("ding");
  await page.getByLabel("Fade in (seconds)").fill("11");
  await expect(appShell(page)).toHaveAttribute("data-visual-pending", "true");
  await page.locator(".scene-list-item").nth(1).click();
  await voice(page).selectOption("");
  await expect(appShell(page)).toHaveAttribute("data-visual-pending", "true");
  await expect(missing).toContainText("Used by scenes 1, 2.");
});

test("a card's delete warning counts the pending draft, so a pending change is never under-counted", async ({page}) => {
  await openApp(page);
  await importInput(page).setInputFiles(upload("tone-440-2.2s.wav"));
  await expect(card(page, "tone-440-2.2s")).toHaveCount(1);

  const ref = await card(page, "tone-440-2.2s").getAttribute("data-local-asset-card");

  await applyYaml(page, ghostStoryYaml.replaceAll(GHOST, ref));
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await music(page).selectOption("ding");
  await page.getByLabel("Fade in (seconds)").fill("11");
  await expect(appShell(page)).toHaveAttribute("data-visual-pending", "true");
  await page.locator(".scene-list-item").nth(1).click();
  await voice(page).selectOption("");

  await page.getByRole("button", {name: "Delete tone-440-2.2s", exact: true}).click();
  await expect(page.getByRole("dialog")).toContainText("Used by scene 1.");
  await expect(page.getByRole("dialog")).not.toContainText("scenes 1, 2");
  await page.getByRole("dialog").getByRole("button", {name: "Cancel"}).click();
});

// ---------------------------------------------------------------------------
// The Player's bundled audio comes from the page's bundled-audio store (AUDIO-004 task 5)
// ---------------------------------------------------------------------------

const DING = "**/audio/sfx/ding.wav";
const dingYaml = (sceneCount = 10) =>
  [
    "title: Bundled ding",
    "scenes:",
    ...Array.from({length: sceneCount}, (_, index) => [
      "  - type: dialogue",
      "    pose: confused",
      "    background: office",
      `    text: Scene ${index + 1}`,
      "    sfx:",
      "      src: ding",
      "    duration: 1",
    ]).flat(),
    "",
  ].join("\n");
const dingRequests = (page) => {
  const urls = [];

  page.on("request", (request) => {
    if (request.url().endsWith("/audio/sfx/ding.wav")) {
      urls.push(request.url());
    }
  });

  return urls;
};
// Counts every sound the page starts (Web Audio sources and media elements), except Remotion's silent pool.
const installStartCounter = () => {
  window.__starts = 0;

  for (const prototype of [AudioBufferSourceNode.prototype, AudioScheduledSourceNode.prototype]) {
    const original = prototype.start;

    prototype.start = function start(...args) {
      window.__starts += 1;

      return original.apply(this, args);
    };
  }

  const originalPlay = HTMLMediaElement.prototype.play;

  HTMLMediaElement.prototype.play = function play(...args) {
    if (!this.src.startsWith("data:")) {
      window.__starts += 1;
    }

    return originalPlay.apply(this, args);
  };
};
const starts = (page) => page.evaluate(() => window.__starts);
const volumeToggle = (page) => page.locator('.preview-frame button[aria-label$=" sound"]');
const unmuteAndPlay = async (page) => {
  await volumeToggle(page).click();
  await expect(volumeToggle(page)).toHaveAttribute("aria-label", "Mute sound");
  await page.getByRole("button", {name: "Play video"}).click();
};
const importStory = (page, source) =>
  page.locator(".project-toolbar input[type=file]").setInputFiles({
    name: "story.yaml",
    mimeType: "text/yaml",
    buffer: Buffer.from(source),
  });
const armed = (page) =>
  expect(page.locator(".preview-frame")).toHaveAttribute("data-tora-audio-armed", "true");

test("ten scenes using ding fetch /audio/sfx/ding.wav once, and the Player plays it from a blob: URL without another request", async ({page}) => {
  const requests = dingRequests(page);

  await page.addInitScript(installStartCounter);
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await importStory(page, dingYaml());
  await armed(page);
  await expect.poll(() => requests.length).toBe(1);

  await unmuteAndPlay(page);
  // Positive control: the Player does sound its ding once the check passed.
  await expect.poll(() => starts(page), {timeout: 10_000}).toBeGreaterThan(0);
  expect(requests).toHaveLength(1);
});

test("a ding file that cannot be decoded is unusable: the Player mounts nothing for it and makes no media request", async ({page}) => {
  const requests = dingRequests(page);

  await page.addInitScript(installStartCounter);
  await page.route(DING, (route) =>
    route.fulfill({status: 200, contentType: "audio/wav", body: "this is not audio"}),
  );
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await importStory(page, dingYaml());
  await armed(page);
  await expect.poll(() => requests.length).toBe(1);

  await unmuteAndPlay(page);
  await expect.poll(() => page.locator(".preview-frame").getAttribute("data-tora-frame")).not.toBe("0");
  await page.waitForTimeout(1_500);
  expect(await starts(page)).toBe(0);
  expect(requests).toHaveLength(1);
});

test("an unusable ding does not silence the Story's music, which still plays after unmute", async ({page}) => {
  const requests = dingRequests(page);

  await page.addInitScript(installStartCounter);
  await page.route(DING, (route) =>
    route.fulfill({status: 200, contentType: "audio/wav", body: "this is not audio"}),
  );
  await openApp(page);
  await importInput(page).setInputFiles(upload("tone-220-12s.wav"));
  await expect(card(page, "tone-220-12s")).toHaveCount(1);

  const ref = await card(page, "tone-220-12s").getAttribute("data-local-asset-card");

  await importStory(
    page,
    dingYaml(3).replace("scenes:", `music:\n  src: ${ref}\nscenes:`),
  );
  await armed(page);
  await expect.poll(() => requests.length).toBe(1);
  await unmuteAndPlay(page);
  await expect.poll(() => starts(page), {timeout: 10_000}).toBeGreaterThan(0);
  expect(requests).toHaveLength(1);
});

test("a failed first request recovers by itself: the retry mounts the track with no navigation, select or Story change", async ({page}) => {
  test.setTimeout(40_000);

  const requests = dingRequests(page);
  let attempts = 0;

  await page.addInitScript(installStartCounter);
  await page.route(DING, (route) => {
    attempts += 1;

    return attempts === 1 ? route.abort("failed") : route.continue();
  });
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await importStory(page, dingYaml(20));
  await armed(page);
  await unmuteAndPlay(page);
  await expect.poll(() => requests.length).toBe(2);
  // The 1 s retry succeeded while the Player was playing: a later scene's ding sounds.
  await expect.poll(() => starts(page), {timeout: 15_000}).toBeGreaterThan(0);
  expect(requests).toHaveLength(2);
});

test("while the check is pending the Player plays nothing for ding, and releasing the route with valid bytes mounts it from a blob: URL (no second request)", async ({page}) => {
  const requests = dingRequests(page);
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  await page.addInitScript(installStartCounter);
  await page.route(DING, async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await importStory(page, dingYaml(20));
  await armed(page);
  await expect.poll(() => requests.length).toBe(1);
  await unmuteAndPlay(page);
  await expect
    .poll(async () => Number(await page.locator(".preview-frame").getAttribute("data-tora-frame")))
    .toBeGreaterThan(40);
  expect(await starts(page)).toBe(0);
  expect(requests).toHaveLength(1);

  release();
  await expect.poll(() => starts(page), {timeout: 15_000}).toBeGreaterThan(0);
  expect(requests).toHaveLength(1);
});

test("a held route released with undecodable bytes never mounts ding", async ({page}) => {
  const requests = dingRequests(page);
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  await page.addInitScript(installStartCounter);
  await page.route(DING, async (route) => {
    await gate;
    await route.fulfill({status: 200, contentType: "audio/wav", body: "this is not audio"});
  });
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await importStory(page, dingYaml(20));
  await armed(page);
  await expect.poll(() => requests.length).toBe(1);
  await unmuteAndPlay(page);
  release();
  await expect
    .poll(async () => Number(await page.locator(".preview-frame").getAttribute("data-tora-frame")))
    .toBeGreaterThan(75);
  expect(await starts(page)).toBe(0);
  expect(requests).toHaveLength(1);
});

test("when every request fails the store gives up after four requests and the Player never mounts ding", async ({page}) => {
  test.setTimeout(40_000);

  const requests = dingRequests(page);

  await page.addInitScript(installStartCounter);
  await page.route(DING, (route) => route.abort("failed"));
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await importStory(page, dingYaml(3));
  await armed(page);
  // 1 + 3 retries at 1 s, 2 s and 4 s.
  await expect.poll(() => requests.length, {timeout: 15_000}).toBe(4);
  await page.waitForTimeout(1_500);
  expect(requests).toHaveLength(4);
  await unmuteAndPlay(page);
  await page.waitForTimeout(1_200);
  expect(await starts(page)).toBe(0);
});

// ---------------------------------------------------------------------------
// The audio timeline under the Player (AUDIO-004 task 6)
// ---------------------------------------------------------------------------

const timeline = (page) => page.locator("[data-audio-timeline]");
const lane = (page, name) => page.locator(`[data-timeline-canvas="${name}"]`);
const paintedPixels = (canvas) =>
  canvas.evaluate((element) => {
    const {data} = element.getContext("2d").getImageData(0, 0, element.width, element.height);
    let painted = 0;

    for (let index = 3; index < data.length; index += 4) {
      if (data[index] > 0) {
        painted += 1;
      }
    }

    return painted;
  });
const frameOf = async (page) => Number(await page.locator(".preview-frame").getAttribute("data-tora-frame"));
const sceneStory = (extras = {}) =>
  [
    "title: Timeline fixture",
    ...(extras.music === undefined ? [] : ["music:", `  src: ${extras.music}`, ...(extras.musicTail ?? [])]),
    "scenes:",
    "  - type: intro",
    "    pose: formal",
    "    background: office",
    "    text: One",
    "    sfx:",
    "      src: ding",
    "    duration: 2",
    "  - type: dialogue",
    "    pose: formal",
    "    background: office",
    "    text: Two",
    ...(extras.voice === undefined ? [] : ["    voice:", `      src: ${extras.voice}`]),
    "    duration: 2",
    "  - type: chaos",
    "    pose: panic",
    "    background: office",
    "    text: Three",
    "    duration: 2",
    "",
  ].join("\n");

test("a Story with sfx ding draws a non-empty effects-lane waveform with no library import, and a silent Story has no timeline", async ({page}) => {
  await openApp(page);
  await expect(timeline(page)).toHaveCount(0);

  await importStory(page, sceneStory());
  await expect(timeline(page)).toHaveCount(1);
  await expect(timeline(page)).toHaveAttribute("data-audio-tracks", "sfx-0");
  await expect(timeline(page).locator("[data-timeline-scene]")).toHaveCount(3);
  await expect.poll(() => paintedPixels(lane(page, "effects"))).toBeGreaterThan(50);
  expect(await paintedPixels(lane(page, "music"))).toBe(0);
  await expect(page.locator("[data-timeline-placeholder]")).toHaveCount(0);

  await importStory(page, "title: Quiet\nscenes:\n  - type: intro\n    pose: formal\n    background: office\n    text: Quiet\n    duration: 2\n");
  await expect(timeline(page)).toHaveCount(0);
});

test("scene blocks are proportional to their length and carry the scene number", async ({page}) => {
  await openApp(page);
  await importStory(
    page,
    sceneStory().replace("    duration: 2\n  - type: dialogue", "    duration: 4\n  - type: dialogue"),
  );

  const blocks = timeline(page).locator("[data-timeline-scene]");

  await expect(blocks).toHaveCount(3);
  await expect(blocks.nth(0)).toHaveText("1");
  await expect(blocks.nth(2)).toHaveText("3");

  const widths = await blocks.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().width),
  );

  // 4 s : 2 s : 2 s.
  expect(widths[0] / widths[1]).toBeCloseTo(2, 1);
  expect(widths[1] / widths[2]).toBeCloseTo(1, 1);
});

test("clicking the timeline seeks the Player and moves the playhead", async ({page}) => {
  await openApp(page);
  await importStory(page, sceneStory());
  await expect(timeline(page)).toHaveCount(1);

  const box = await timeline(page).boundingBox();

  await page.mouse.click(box.x + box.width * 0.5, box.y + 30);
  // 180 frames: the middle is frame 90, the start of scene 2.
  await expect.poll(() => frameOf(page)).toBe(90);
  await expect(timeline(page)).toHaveAttribute("aria-valuenow", "90");

  const playheadLeft = await page.locator("[data-timeline-playhead]").evaluate((element) => element.style.left);

  expect(Number.parseFloat(playheadLeft)).toBeCloseTo(50, 0);

  await page.mouse.click(box.x + box.width - 1, box.y + 30);
  await expect.poll(() => frameOf(page)).toBe(179);
});

test("the timeline is one focusable slider: arrows jump between scene starts, Home and End to the ends, and the label says where it is", async ({page}) => {
  await openApp(page);
  await importStory(page, sceneStory());
  await expect(timeline(page)).toHaveCount(1);
  await expect(timeline(page)).toHaveAttribute("role", "slider");
  await expect(timeline(page)).toHaveAttribute("tabindex", "0");
  await expect(timeline(page)).toHaveAttribute("aria-label", "Audio timeline, scene 1 of 3, 0:00 of 0:06");

  await timeline(page).focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => frameOf(page)).toBe(60);
  await expect(timeline(page)).toHaveAttribute("aria-label", "Audio timeline, scene 2 of 3, 0:02 of 0:06");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => frameOf(page)).toBe(120);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => frameOf(page)).toBe(179);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => frameOf(page)).toBe(120);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => frameOf(page)).toBe(0);
  await page.keyboard.press("End");
  await expect.poll(() => frameOf(page)).toBe(179);
  await page.keyboard.press("Home");
  await expect.poll(() => frameOf(page)).toBe(0);
});

test("while the Player plays only the playhead moves: the lanes are not redrawn per frame", async ({page}) => {
  await page.addInitScript(() => {
    window.__laneDraws = 0;

    const original = CanvasRenderingContext2D.prototype.fillRect;

    CanvasRenderingContext2D.prototype.fillRect = function fillRect(...args) {
      window.__laneDraws += 1;

      return original.apply(this, args);
    };
  });
  await openApp(page);
  await importStory(page, sceneStory());
  await expect.poll(() => paintedPixels(lane(page, "effects"))).toBeGreaterThan(50);
  await page.waitForTimeout(300);

  const draws = await page.evaluate(() => window.__laneDraws);
  const before = await page.locator("[data-timeline-playhead]").evaluate((element) => element.style.left);

  await page.getByRole("button", {name: "Play video"}).click();
  await expect.poll(() => frameOf(page)).toBeGreaterThan(30);
  await page.getByRole("button", {name: "Pause video"}).click();

  const after = await page.locator("[data-timeline-playhead]").evaluate((element) => element.style.left);

  expect(Number.parseFloat(after)).toBeGreaterThan(Number.parseFloat(before));
  expect(await page.evaluate(() => window.__laneDraws)).toBe(draws);
});

test("the lanes follow a resize of the page", async ({page}) => {
  await openApp(page);
  await importStory(page, sceneStory());
  await expect.poll(() => paintedPixels(lane(page, "effects"))).toBeGreaterThan(50);

  const width = () => lane(page, "effects").evaluate((element) => element.width);
  const wide = await width();

  await page.setViewportSize({width: 420, height: 1500});
  await expect.poll(width).toBeLessThan(wide);
  await expect.poll(() => paintedPixels(lane(page, "effects"))).toBeGreaterThan(20);
});

test("an unusable ding shows a hatched block with the role label instead of a waveform, and a track that is still loading a plain one", async ({page}) => {
  const requests = dingRequests(page);
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  await page.route(DING, async (route) => {
    await gate;
    await route.fulfill({status: 200, contentType: "audio/wav", body: "this is not audio"});
  });
  await openApp(page);
  await importStory(page, sceneStory());
  await expect.poll(() => requests.length).toBe(1);

  const block = page.locator("[data-timeline-placeholder]");

  // The check is pending: a plain block of the right length (ding is 1.2 s of 6 s) and no waveform.
  await expect(block).toHaveAttribute("data-timeline-placeholder", "plain");
  await expect(block).toHaveText("Sound effect");
  await expect(timeline(page)).toHaveAttribute("data-audio-tracks", "");
  expect(await paintedPixels(lane(page, "effects"))).toBe(0);

  const [laneBox, blockBox] = await Promise.all([
    page.locator('[data-timeline-lane="effects"]').boundingBox(),
    block.boundingBox(),
  ]);

  expect(blockBox.width / laneBox.width).toBeCloseTo(36 / 180, 1);

  release();
  await expect(block).toHaveAttribute("data-timeline-placeholder", "hatched");
  await expect(block).toHaveAttribute("data-timeline-role", "sfx");
  expect(await paintedPixels(lane(page, "effects"))).toBe(0);
});

test("a ding whose first request fails shows a plain block that turns into a waveform by itself", async ({page}) => {
  test.setTimeout(30_000);

  let attempts = 0;

  await page.route(DING, (route) => {
    attempts += 1;

    return attempts === 1 ? route.abort("failed") : route.continue();
  });
  await openApp(page);
  await importStory(page, sceneStory());
  await expect(page.locator("[data-timeline-placeholder]")).toHaveAttribute("data-timeline-placeholder", "plain");
  await expect(page.locator("[data-timeline-placeholder]")).toHaveCount(0, {timeout: 10_000});
  await expect(timeline(page)).toHaveAttribute("data-audio-tracks", "sfx-0");
  await expect.poll(() => paintedPixels(lane(page, "effects"))).toBeGreaterThan(50);
});

test("music and voice draw in their lanes from the stored peaks, and deleting the voice from My audio turns it into a hatched block while ding stays", async ({page}) => {
  await openApp(page);
  await importInput(page).setInputFiles(upload("tone-220-12s.wav"));
  await expect(card(page, "tone-220-12s")).toHaveCount(1);
  await importInput(page).setInputFiles(upload("tone-440-2.2s.wav"));
  await expect(card(page, "tone-440-2.2s")).toHaveCount(1);

  const musicRef = await card(page, "tone-220-12s").getAttribute("data-local-asset-card");
  const voiceRef = await card(page, "tone-440-2.2s").getAttribute("data-local-asset-card");

  await importStory(page, sceneStory({music: musicRef, musicTail: ["  fadeIn: 1"], voice: voiceRef}));
  await expect(timeline(page)).toHaveAttribute("data-audio-tracks", "music-0 sfx-0 voice-1");
  await expect.poll(() => paintedPixels(lane(page, "music"))).toBeGreaterThan(200);
  await expect.poll(() => paintedPixels(lane(page, "effects"))).toBeGreaterThan(100);
  await expect(page.locator("[data-timeline-placeholder]")).toHaveCount(0);

  await page.getByRole("button", {name: "Delete tone-440-2.2s", exact: true}).click();
  await page.getByRole("dialog").getByRole("button", {name: "Delete asset anyway"}).click();
  await expect(card(page, "tone-440-2.2s")).toHaveCount(0);

  const hatched = page.locator('[data-timeline-placeholder="hatched"]');

  await expect(hatched).toHaveCount(1);
  await expect(hatched).toHaveText("Voice");
  await expect(timeline(page)).toHaveAttribute("data-audio-tracks", "music-0 sfx-0");
  await expect.poll(() => paintedPixels(lane(page, "effects"))).toBeGreaterThan(20);
});

// ---------------------------------------------------------------------------
// Plan warnings in the editor (AUDIO-004 task 7)
// ---------------------------------------------------------------------------

const notice = (page, text) =>
  page.getByRole("status").filter({hasText: text});
// The warning blocks are always mounted (a live region that appears already full is not announced reliably):
// tests read them by name and "no warning" means an empty block.
const noticeFor = (page, name) => page.locator(`[data-audio-notices="${name}"]`);
const sceneNotices = (page) => page.locator("[data-scene-audio] [data-audio-notices]");
const sceneYaml = ({music, tail = [], sfx, voice, durations = [2, 2]}) =>
  [
    "title: Warnings",
    ...(music === undefined ? [] : ["music:", `  src: ${music}`, ...tail]),
    "scenes:",
    ...durations.flatMap((duration, index) => [
      "  - type: dialogue",
      "    pose: formal",
      "    background: office",
      `    text: Scene ${index + 1}`,
      ...(index === 0 && sfx !== undefined ? ["    sfx:", `      src: ${sfx}`] : []),
      ...(index === 0 && voice !== undefined ? ["    voice:", `      src: ${voice}`] : []),
      `    duration: ${duration}`,
    ]),
    "",
  ].join("\n");
const importLibrary = async (page, names) => {
  const refs = [];

  for (const name of names) {
    await importInput(page).setInputFiles(upload(name));

    const label = name.replace(/\.[^.]+$/u, "");

    await expect(card(page, label)).toHaveCount(1);
    refs.push(await card(page, label).getAttribute("data-local-asset-card"));
  }

  return refs;
};

test("Voice is cut by X s appears on the scene's voice, and goes when the scene is long enough", async ({page}) => {
  await openApp(page);

  const [voiceRef] = await importLibrary(page, ["tone-440-2.2s.wav"]);

  await applyYaml(page, sceneYaml({voice: voiceRef, durations: [1, 2]}));
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await expect(notice(page, "Voice is cut by 1.2 s.")).toHaveCount(1);
  await expect(noticeFor(page, "voice")).toHaveText("Voice is cut by 1.2 s.");
  await expect(noticeFor(page, "sfx")).toHaveText("");

  await page.getByLabel("Duration (seconds)").fill("3");
  await expect(notice(page, "Voice is cut")).toHaveCount(0);
});

test("the music panel warns when fades do not fit, when the music is too short to loop and when the mix may clip", async ({page}) => {
  await openApp(page);

  const [musicRef] = await importLibrary(page, ["tone-220-12s.wav"]);

  await applyYaml(page, sceneYaml({music: musicRef, tail: ["  fadeIn: 2", "  fadeOut: 2"], durations: [1, 2]}));
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await expect(noticeFor(page, "music")).toHaveText("Fades shortened to fit the Story.");
  await expect(music(page)).toHaveAttribute("aria-describedby", await noticeFor(page, "music").getAttribute("id"));

  // 12 s of full-volume music in a 20 s Story loops and crosses over at sqrt(2).
  await applyYaml(page, sceneYaml({music: musicRef, durations: [10, 10]}));
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await expect(noticeFor(page, "music")).toHaveText("The mix may clip (peak gain 1.5).");
  await page.getByLabel("Music volume").fill("0.5");
  await expect(noticeFor(page, "music")).toHaveText("");

  await applyYaml(page, sceneYaml({music: "pop"}));
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await expect(noticeFor(page, "music")).toHaveText("This music is too short to loop (under 1 s); it plays once.");
});

test("deleting the voice from My audio shows Audio not available on the voice field and removes its track while ding keeps playing", async ({page}) => {
  await page.addInitScript(installStartCounter);
  await openApp(page);

  const [voiceRef] = await importLibrary(page, ["tone-440-2.2s.wav"]);

  await applyYaml(page, sceneYaml({sfx: "ding", voice: voiceRef, durations: [3, 2]}));
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await expect(timeline(page)).toHaveAttribute("data-audio-tracks", "sfx-0 voice-0");
  await expect(sceneNotices(page)).toHaveText(["", ""]);

  await page.getByRole("button", {name: "Delete tone-440-2.2s", exact: true}).click();
  await page.getByRole("dialog").getByRole("button", {name: "Delete asset anyway"}).click();

  await expect(noticeFor(page, "voice")).toHaveText("Audio not available: render blocked.");
  await expect(voice(page)).toHaveAttribute("aria-describedby", await noticeFor(page, "voice").getAttribute("id"));
  await expect(timeline(page)).toHaveAttribute("data-audio-tracks", "sfx-0");
  await expect(page.getByRole("button", {name: "Render MP4"})).toBeDisabled();

  // ding still sounds after unmute.
  await unmuteAndPlay(page);
  await expect.poll(() => starts(page), {timeout: 10_000}).toBeGreaterThan(0);
});

test("an undecodable ding shows Audio not available on the sound effect field with no other interaction", async ({page}) => {
  await page.route(DING, (route) =>
    route.fulfill({status: 200, contentType: "audio/wav", body: "this is not audio"}),
  );
  await openApp(page);
  await applyYaml(page, sceneYaml({sfx: "ding"}));
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await expect(noticeFor(page, "sfx")).toHaveText("Audio not available: render blocked.");
  await expect(page.locator('[data-timeline-placeholder="hatched"]')).toHaveText("Sound effect");
});

test("while ding is loading the field shows no text, and when every request fails it shows the load error with a Retry that works once the route is fixed", async ({page}) => {
  test.setTimeout(45_000);

  const requests = dingRequests(page);
  let broken = true;

  await page.route(DING, (route) => (broken ? route.abort("failed") : route.continue()));
  await openApp(page);
  await applyYaml(page, sceneYaml({sfx: "ding"}));
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await expect.poll(() => requests.length).toBeGreaterThanOrEqual(1);
  // Retrying: a plain block, no warning.
  await expect(page.locator("[data-timeline-placeholder]")).toHaveAttribute("data-timeline-placeholder", "plain");
  await expect(sceneNotices(page)).toHaveText(["", ""]);

  const retry = page.getByRole("button", {name: "Retry loading Ding"});

  await expect(retry).toBeVisible({timeout: 15_000});
  expect(requests).toHaveLength(4);
  await expect(noticeFor(page, "sfx")).toContainText("Audio could not be loaded.");
  // The select is described by its warning, so a screen reader reads both together.
  await expect(sfx(page)).toHaveAttribute("aria-describedby", await noticeFor(page, "sfx").getAttribute("id"));
  await expect(page.locator("[data-timeline-placeholder]")).toHaveAttribute("data-timeline-placeholder", "plain");

  broken = false;
  await retry.click();
  await expect(retry).toHaveCount(0);
  // The button is gone: focus went back to the field instead of falling to the page.
  await expect(sfx(page)).toBeFocused();
  await expect(sceneNotices(page)).toHaveText(["", ""]);
  await expect(timeline(page)).toHaveAttribute("data-audio-tracks", "sfx-0");
  await expect.poll(() => paintedPixels(lane(page, "effects"))).toBeGreaterThan(20);
  expect(requests).toHaveLength(5);
});

test("warnings are not shown while a visual draft is pending, because the plan belongs to the Active Story", async ({page}) => {
  await openApp(page);

  const [voiceRef] = await importLibrary(page, ["tone-440-2.2s.wav"]);

  await applyYaml(page, sceneYaml({voice: voiceRef, durations: [1, 2]}));
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await expect(notice(page, "Voice is cut by 1.2 s.")).toHaveCount(1);
  await music(page).selectOption("ding");
  await page.getByLabel("Fade in (seconds)").fill("11");
  await expect(appShell(page)).toHaveAttribute("data-visual-pending", "true");
  await expect(notice(page, "Voice is cut")).toHaveCount(0);
  await page.getByLabel("Fade in (seconds)").fill("1");
  await expect(appShell(page)).toHaveAttribute("data-visual-pending", "false");
  await expect(notice(page, "Voice is cut by 1.2 s.")).toHaveCount(1);
});

test("a local voice and ding both play after unmute, each from a blob: URL, with no network request for ding beyond the store's one", async ({page}) => {
  const requests = dingRequests(page);

  await page.addInitScript(installStartCounter);
  await page.addInitScript(() => {
    window.__blobFetches = [];

    const original = window.fetch;

    window.fetch = function fetchSpy(input, ...rest) {
      const target = typeof input === "string" ? input : input.url;

      if (typeof target === "string" && target.startsWith("blob:")) {
        window.__blobFetches.push(target);
      }

      return original.call(this, input, ...rest);
    };
  });
  await openApp(page);

  const [voiceRef] = await importLibrary(page, ["tone-440-2.2s.wav"]);

  await applyYaml(page, sceneYaml({sfx: "ding", voice: voiceRef, durations: [6, 2]}));
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await expect(timeline(page)).toHaveAttribute("data-audio-tracks", "sfx-0 voice-0");
  await unmuteAndPlay(page);
  await expect.poll(() => starts(page), {timeout: 10_000}).toBeGreaterThan(0);
  expect(requests).toHaveLength(1);
  // Each of the two tracks is read from its own blob: URL (the library's verified payload and the store's checked ding).
  expect(new Set(await page.evaluate(() => window.__blobFetches)).size).toBe(2);
});
