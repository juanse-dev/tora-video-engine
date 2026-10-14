import {createHash} from "node:crypto";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, test} from "@playwright/test";
import {buildWav, fixtureBytes} from "../helpers/audioBytes.mjs";
import {
  audioWavRecord,
  deleteAssetRows,
  localAssetRef,
} from "./helpers/seedAssetLibrary.mjs";
import {applyYaml, openSeeded, waitForOwner} from "./helpers/localAssetPage.mjs";

const MIB = 1024 * 1024;
const section = (page) => page.locator("[data-my-audio]");
const importInput = (page) => section(page).locator('.my-assets-toolbar input[type="file"]');
const statusLine = (page) => section(page).getByRole("status");
const alertLine = (page) => section(page).getByRole("alert");
const cards = (page) => section(page).locator("[data-local-asset-card]");
const cardFor = (page, ref) => page.locator(`[data-local-asset-card="${ref}"]`);
const missingCard = (page, ref) => page.locator(`[data-missing-local-asset-card="${ref}"]`);
const heading = (page, total) => section(page).getByRole("heading", {name: `My audio · ${total}`});
const refOf = (bytes) => localAssetRef("audio", createHash("sha256").update(bytes).digest("hex"));
const upload = (name, bytes, mimeType = "application/octet-stream") => ({name, mimeType, buffer: Buffer.from(bytes)});
const imported = (label) => `Imported "${label}".`;

// Playwright refuses in-memory upload buffers over 50 MiB, so large files are uploaded by path.
const tempDirectories = [];
const tempFile = async (name, bytes) => {
  const directory = await mkdtemp(join(tmpdir(), "tora-my-audio-"));

  tempDirectories.push(directory);

  const path = join(directory, name);

  await writeFile(path, bytes);

  return path;
};

test.afterAll(async () => {
  for (const directory of tempDirectories) {
    await rm(directory, {recursive: true, force: true});
  }
});

const yamlSource = async (page) => {
  await page.getByRole("button", {name: "Open YAML"}).click();

  const source = await page.getByLabel("YAML source").inputValue();

  await page.getByRole("button", {name: "Open visual editor"}).click();

  return source;
};

const audioStoryYaml = ({music, scenes}) =>
  [
    "title: Audio story",
    ...(music === undefined ? [] : ["music:", `  src: ${music}`]),
    "scenes:",
    ...scenes.flatMap(({sfx, voice, duration = 3}, index) => [
      "  - type: dialogue",
      "    pose: formal",
      "    background: office",
      "    animation: fade",
      `    text: Scene ${index + 1}`,
      ...(sfx === undefined ? [] : ["    sfx:", `      src: ${sfx}`]),
      ...(voice === undefined ? [] : ["    voice:", `      src: ${voice}`]),
      `    duration: ${duration}`,
    ]),
    "",
  ].join("\n");

test("the asset catalog ends with a My audio block next to the unchanged image sections", async ({page}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  await expect(page.getByRole("heading", {name: /^My assets/u})).toHaveCount(2);
  await expect(page.getByRole("heading", {name: "Bundled"})).toHaveCount(2);
  await expect(heading(page, 0)).toBeVisible();
  await expect(section(page).getByText("No imported audio yet.")).toBeVisible();
  await expect(importInput(page)).toBeEnabled();
});

test("importing WAV, MP3 and Ogg Opus shows a card per file with its m:ss duration and leaves the Story alone", async ({page}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const before = await yamlSource(page);
  const files = [
    ["tone-440-2.2s.wav", "tone-440-2.2s", "0:02"],
    ["tone-440-2.2s.mp3", "tone-440-2.2s", "0:02"],
    ["tone-440-2.2s.opus.ogg", "tone-440-2.2s.opus", "0:02"],
    ["tone-220-10s.wav", "tone-220-10s", "0:10"],
  ];

  for (const [index, [name, label, duration]] of files.entries()) {
    const bytes = fixtureBytes(name);
    const ref = refOf(bytes);

    await importInput(page).setInputFiles(upload(name, bytes));
    await expect(statusLine(page)).toHaveText(imported(label));
    await expect(heading(page, index + 1)).toBeVisible();
    await expect(cardFor(page, ref)).toContainText(label);
    await expect(cardFor(page, ref).locator("[data-audio-duration]")).toHaveText(duration);
    await expect(cardFor(page, ref).getByRole("button", {name: `Rename ${label}`})).toBeVisible();
  }

  await expect(cards(page)).toHaveCount(4);
  expect(await yamlSource(page)).toBe(before);
  await expect(page.locator(".app-shell")).toHaveAttribute("data-authoring-locked", "false");
});

test("importing the same file again says it was already in My audio and keeps one card", async ({page}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const bytes = fixtureBytes("tone-440-2.2s.wav");

  await importInput(page).setInputFiles(upload("tone-440-2.2s.wav", bytes));
  await expect(statusLine(page)).toHaveText(imported("tone-440-2.2s"));
  await importInput(page).setInputFiles(upload("tone-440-2.2s.wav", bytes));
  await expect(statusLine(page)).toHaveText('"tone-440-2.2s" was already in My audio; its stored copy was refreshed.');
  await expect(cards(page)).toHaveCount(1);
  await expect(heading(page, 1)).toBeVisible();
});

test("each rejected file shows its message, stores nothing and changes nothing", async ({page}) => {
  test.setTimeout(60_000);
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const before = await yamlSource(page);
  // Equal messages are never adjacent, so a stale alert cannot satisfy the next assertion.
  const cases = [
    ["not-audio.txt", upload("not-audio.txt", fixtureBytes("not-audio.txt")), "This is not a supported audio file. Use MP3, WAV, M4A or Ogg Opus."],
    ["three-channel.wav", upload("three-channel.wav", fixtureBytes("three-channel.wav")), "Audio must be mono or stereo."],
    ["with-video.mp4", upload("with-video.mp4", fixtureBytes("with-video.mp4")), "Video files are not supported. Use an audio file."],
    ["zero-channel.wav", upload("zero-channel.wav", fixtureBytes("zero-channel.wav")), "Audio must be mono or stereo."],
    ["long-301s.mp3", upload("long-301s.mp3", fixtureBytes("long-301s.mp3")), "Audio can be at most 300 seconds (5 minutes) long."],
    ["truncated.mp3", upload("truncated.mp3", fixtureBytes("truncated.mp3")), "This audio file looks truncated."],
    ["empty.wav", upload("empty.wav", new Uint8Array(0)), "This audio file is empty."],
    ["huge.wav", await tempFile("huge.wav", buildWav({dataBytes: 51 * MIB - 44})), "This audio file is larger than 50 MiB."],
  ];

  for (const [, file, message] of cases) {
    await importInput(page).setInputFiles(file);
    await expect(alertLine(page)).toHaveText(message);
    await expect(cards(page)).toHaveCount(0);
    await expect(heading(page, 0)).toBeVisible();
    await expect(page.locator(".app-shell")).toHaveAttribute("data-authoring-locked", "false");
  }

  expect(await yamlSource(page)).toBe(before);
});

test("a 30 MiB WAV imports: the audio limit is 50 MiB, not the 25 MiB image limit", async ({page}) => {
  test.setTimeout(90_000);
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const bytes = buildWav({dataBytes: 30 * MIB - 44});

  await importInput(page).setInputFiles(await tempFile("big.wav", bytes));
  await expect(statusLine(page)).toHaveText(imported("big"), {timeout: 60_000});
  await expect(cardFor(page, refOf(bytes)).locator("[data-audio-duration]")).toHaveText("2:44");
});

test("an M4A (AAC) is imported where the browser decodes AAC and refused as undecodable where it does not", async ({page}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);

  const aac = await page.evaluate(async () =>
    typeof AudioDecoder === "undefined"
      ? false
      : (await AudioDecoder.isConfigSupported({codec: "mp4a.40.2", sampleRate: 44_100, numberOfChannels: 2})).supported === true,
  );

  await importInput(page).setInputFiles(upload("tone-440-2.2s.m4a", fixtureBytes("tone-440-2.2s.m4a")));

  if (aac) {
    await expect(statusLine(page)).toHaveText(imported("tone-440-2.2s"));
    await expect(cards(page)).toHaveCount(1);
  } else {
    await expect(alertLine(page)).toHaveText("This audio file could not be decoded.");
    await expect(cards(page)).toHaveCount(0);
  }
});

test("rename changes the label only (Enter saves, Escape cancels) and never the Story", async ({page}) => {
  const record = await audioWavRecord("tone-440-2.2s.wav");

  await openSeeded(page, [record]);

  const before = await yamlSource(page);
  const card = cardFor(page, record.ref);

  await card.getByRole("button", {name: "Rename tone-440-2.2s"}).click();
  await card.getByLabel("New name for tone-440-2.2s").fill("  Narration  ");
  await card.getByLabel("New name for tone-440-2.2s").press("Enter");
  await expect(card).toContainText("Narration");
  await expect(card.locator("[data-audio-duration]")).toHaveText("0:02");

  await card.getByRole("button", {name: "Rename Narration"}).click();
  await card.getByLabel("New name for Narration").fill("Discarded");
  await card.getByLabel("New name for Narration").press("Escape");
  await expect(card).toContainText("Narration");
  await expect(card).not.toContainText("Discarded");
  expect(await yamlSource(page)).toBe(before);
});

test("delete counts the scenes using the ref in any audio role, music included; the missing card and Import matching file restore it", async ({page}) => {
  const music = await audioWavRecord("tone-220-10s.wav");
  const voice = await audioWavRecord("tone-440-2.2s.wav");
  const spare = await audioWavRecord("tone-880-0.4s.wav");

  await openSeeded(page, [music, voice, spare]);
  await applyYaml(
    page,
    audioStoryYaml({
      music: music.ref,
      scenes: [{sfx: voice.ref}, {voice: voice.ref, duration: "auto"}],
    }),
  );
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await expect(heading(page, 3)).toBeVisible();
  await expect(missingCard(page, music.ref)).toHaveCount(0);

  // An unused file asks the plain question.
  await cardFor(page, spare.ref).getByRole("button", {name: "Delete tone-880-0.4s"}).click();
  await expect(page.getByRole("dialog")).toContainText('Delete "tone-880-0.4s" (audio) from My audio?');
  await page.getByRole("dialog").getByRole("button", {name: "Cancel"}).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The music-only file.
  await cardFor(page, music.ref).getByRole("button", {name: "Delete tone-220-10s"}).click();
  await expect(page.getByRole("dialog")).toContainText("Used by the music.");
  await page.getByRole("dialog").getByRole("button", {name: "Cancel"}).click();

  // The file used by sfx in scene 1 and voice in scene 2.
  await cardFor(page, voice.ref).getByRole("button", {name: "Delete tone-440-2.2s"}).click();
  await expect(page.getByRole("dialog")).toContainText("Used by scenes 1, 2.");
  await page.getByRole("dialog").getByRole("button", {name: "Delete asset anyway"}).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(heading(page, 2)).toBeVisible();
  await expect(cardFor(page, voice.ref)).toHaveCount(0);

  const missing = missingCard(page, voice.ref);

  await expect(missing).toBeVisible();
  await expect(missing).toContainText("Missing local audio");
  await expect(missing).toContainText("Used by scenes 1, 2.");
  await expect(missing).toContainText("Import the original file to restore it.");

  // A different audio file cannot restore it and writes nothing.
  await missing.locator('input[type="file"]').setInputFiles(upload("tone-880-0.4s.wav", fixtureBytes("tone-880-0.4s.wav")));
  await expect(alertLine(page)).toContainText("This file is a different audio file");
  await expect(missing).toBeVisible();
  await expect(heading(page, 2)).toBeVisible();

  // The exact file restores it and the Story is untouched.
  const yamlBefore = await yamlSource(page);

  await missing.locator('input[type="file"]').setInputFiles(upload("tone-440-2.2s.wav", fixtureBytes("tone-440-2.2s.wav")));
  await expect(statusLine(page)).toHaveText(imported("tone-440-2.2s"));
  await expect(missing).toHaveCount(0);
  await expect(cardFor(page, voice.ref)).toBeVisible();
  await expect(heading(page, 3)).toBeVisible();
  expect(await yamlSource(page)).toBe(yamlBefore);
});

test("a Story ref that is not in the library shows a missing card with its scenes, and a deleted row in another tab appears as missing", async ({page}) => {
  const voice = await audioWavRecord("tone-440-2.2s.wav");

  await openSeeded(page, [voice]);
  await applyYaml(page, audioStoryYaml({scenes: [{voice: voice.ref}]}));
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await expect(cardFor(page, voice.ref)).toBeVisible();
  await expect(missingCard(page, voice.ref)).toHaveCount(0);

  await deleteAssetRows(page, [voice.ref]);
  await page.reload({waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await expect(missingCard(page, voice.ref)).toBeVisible();
  await expect(missingCard(page, voice.ref)).toContainText("Used by scene 1.");
  await expect(heading(page, 0)).toBeVisible();
});

test("a referenced audio whose stored payload is corrupt shows only its damaged card, never also a regular card", async ({page}) => {
  const voice = await audioWavRecord("tone-440-2.2s.wav");
  const other = await audioWavRecord("tone-880-0.4s.wav");
  // The row and metadata stay; the blob under the voice's digest holds other bytes.
  const corrupt = {...voice, bytesBase64: other.bytesBase64};

  await openSeeded(page, [corrupt]);
  await applyYaml(page, audioStoryYaml({scenes: [{voice: voice.ref}]}));
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await expect(missingCard(page, voice.ref)).toBeVisible();
  await expect(cardFor(page, voice.ref)).toHaveCount(0);
  await expect(section(page).locator(`[data-local-asset-card="${voice.ref}"], [data-missing-local-asset-card="${voice.ref}"]`)).toHaveCount(1);
});

test("the Player length comes from the imported voice's duration: one auto scene of a 2.2 s voice is 81 frames, not the 90-frame fallback", async ({page}) => {
  test.setTimeout(60_000);

  const voice = await audioWavRecord("tone-440-2.2s.wav");

  await openSeeded(page, [voice]);
  await applyYaml(page, audioStoryYaml({scenes: [{voice: voice.ref, duration: "auto"}]}));
  await page.getByRole("button", {name: "Open visual editor"}).click();
  await expect(cardFor(page, voice.ref)).toBeVisible();
  // The control bar shows the Player length: 2.7 s ("0:02") from the imported voice, not the 3 s fallback ("0:03").
  await expect(page.locator(".preview-frame")).toContainText("0:00 / 0:02");

  // The Player returns to frame 0 when it ends, so record the highest frame it reaches.
  await page.evaluate(() => {
    const probe = document.querySelector("[data-tora-frame]");

    window.__maxFrame = 0;
    new MutationObserver(() => {
      window.__maxFrame = Math.max(window.__maxFrame, Number(probe.dataset.toraFrame));
    }).observe(probe, {attributes: true, attributeFilter: ["data-tora-frame"]});
  });

  const playButton = page.getByRole("button", {name: "Play video"});

  await expect(playButton).toBeVisible();
  await playButton.click();
  await expect
    .poll(() => page.evaluate(() => window.__maxFrame), {timeout: 15_000})
    .toBeGreaterThanOrEqual(80);
  await page.waitForTimeout(1500);
  // 81 frames: the last is frame 80. The 3 s fallback would have reached frame 89.
  expect(await page.evaluate(() => window.__maxFrame)).toBe(80);
});
