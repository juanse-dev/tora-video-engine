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
