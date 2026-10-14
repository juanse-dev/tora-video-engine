import {expect, test} from "@playwright/test";

// The Player controls sit below the preview; a tall viewport keeps them on screen.
test.use({viewport: {width: 1400, height: 1500}});

const sceneBlock = (index) =>
  [
    "  - type: dialogue",
    "    pose: confused",
    "    background: office",
    `    text: Scene ${index + 1}`,
    "    sfx:",
    "      src: ding",
    "    duration: 1",
  ].join("\n");

// Ten 1 s scenes (300 frames), each starting the bundled `ding`: something
// sounds every second, so a Player that wrongly stays unmuted is caught fast.
const AUDIO_YAML = [
  "title: Audio preview fixture",
  "scenes:",
  ...Array.from({length: 10}, (_, index) => sceneBlock(index)),
  "",
].join("\n");

const SILENT_YAML = [
  "title: Silent preview fixture",
  "scenes:",
  "  - type: intro",
  "    pose: formal",
  "    background: office",
  "    text: Quiet",
  "    duration: 10",
  "",
].join("\n");

// Records every audio start and every mute change with a timestamp, and
// whether the Player showed itself as muted at that moment (the volume button
// reads "Unmute sound" while muted). Remotion's own silent shared <audio>
// pool (data: URLs) is flagged so it can be ignored.
const installAudioSpy = () => {
  window.__audioLog = [];
  window.__muteLog = [];

  const isMutedNow = () =>
    document.querySelector('.preview-frame button[aria-label="Unmute sound"]') !== null;

  for (const [kind, prototype] of [
    ["AudioBufferSourceNode.start", AudioBufferSourceNode.prototype],
    ["AudioScheduledSourceNode.start", AudioScheduledSourceNode.prototype],
  ]) {
    const original = prototype.start;

    prototype.start = function start(...args) {
      window.__audioLog.push({
        kind,
        t: performance.now(),
        muted: isMutedNow(),
        pool: false,
      });

      return original.apply(this, args);
    };
  }

  const originalPlay = HTMLMediaElement.prototype.play;

  HTMLMediaElement.prototype.play = function play(...args) {
    window.__audioLog.push({
      kind: "HTMLMediaElement.play",
      t: performance.now(),
      muted: isMutedNow(),
      pool: this.src.startsWith("data:"),
    });

    return originalPlay.apply(this, args);
  };

  new MutationObserver(() => {
    const value = document
      .querySelector(".preview-frame")
      ?.getAttribute("data-tora-muted");

    if (value !== undefined && value !== null) {
      const last = window.__muteLog[window.__muteLog.length - 1];

      if (last === undefined || last.value !== value) {
        window.__muteLog.push({t: performance.now(), value});
      }
    }
  }).observe(document, {attributes: true, subtree: true, childList: true});
};

const importYaml = async (page, name, source) => {
  await page.locator(".project-toolbar input[type=file]").setInputFiles({
    name,
    mimeType: "text/yaml",
    buffer: Buffer.from(source),
  });
};

const probe = (page, key) =>
  page.locator(".preview-frame").getAttribute(`data-tora-${key}`);
const currentFrame = async (page) => Number(await probe(page, "frame"));
const volumeButton = (page) =>
  page.locator('.preview-frame button[aria-label$=" sound"]');
const markNow = (page) => page.evaluate(() => performance.now());
const auditAfter = (page, since) =>
  page.evaluate(
    (mark) => ({
      starts: window.__audioLog.filter((entry) => entry.t > mark && !entry.pool),
      muteChanges: window.__muteLog.filter((entry) => entry.t > mark),
    }),
    since,
  );

const openWithAudio = async (page) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await expect(page.getByRole("button", {name: "Play video"})).toBeVisible();
  await importYaml(page, "audio.yaml", AUDIO_YAML);
  await expect(page.locator(".preview-frame")).toHaveAttribute(
    "data-tora-audio-armed",
    "true",
  );
};

test("a Story without audio keeps the v0.3 Player: no volume controls, nothing armed", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});

  await expect(page.getByRole("button", {name: "Play video"})).toBeVisible();
  await expect(volumeButton(page)).toHaveCount(0);
  await expect(page.locator(".preview-frame")).toHaveAttribute(
    "data-tora-audio-armed",
    "false",
  );
});

test("a Story with a bundled sfx starts muted, plays after unmute and seeks", async ({
  page,
}) => {
  await page.addInitScript(installAudioSpy);
  await openWithAudio(page);

  await expect(volumeButton(page)).toHaveAttribute("aria-label", "Unmute sound");
  await expect(page.locator(".preview-frame")).toHaveAttribute(
    "data-tora-muted",
    "true",
  );

  await volumeButton(page).click();
  await expect(volumeButton(page)).toHaveAttribute("aria-label", "Mute sound");
  await expect(page.locator(".preview-frame")).toHaveAttribute(
    "data-tora-muted",
    "false",
  );

  const beforePlay = await markNow(page);

  await page.getByRole("button", {name: "Play video"}).click();
  await expect.poll(() => currentFrame(page), {timeout: 10_000}).toBeGreaterThan(5);

  // Positive control for the spy: unmuted playback does start audio.
  await expect
    .poll(
      async () =>
        (await auditAfter(page, beforePlay)).starts.filter((entry) => !entry.muted)
          .length,
      {timeout: 10_000},
    )
    .toBeGreaterThan(0);

  await page.getByRole("button", {name: "Pause video"}).click();

  // Seeking: a click at three quarters of the seek bar lands near frame 224 of 300.
  const bar = await page
    .locator(".preview-frame div")
    .evaluateAll((elements) => {
      const found = elements
        .map((element) => ({
          rect: element.getBoundingClientRect(),
          style: getComputedStyle(element),
        }))
        .find(
          ({rect, style}) =>
            style.cursor === "pointer" &&
            style.touchAction === "none" &&
            rect.width > 200,
        );

      return found === undefined
        ? null
        : {
            x: found.rect.x,
            y: found.rect.y + found.rect.height / 2,
            width: found.rect.width,
          };
    });

  expect(bar).not.toBeNull();
  await page.mouse.click(bar.x + bar.width * 0.75, bar.y);
  await expect
    .poll(() => currentFrame(page), {timeout: 5_000})
    .toBeGreaterThan(200);
  expect(await currentFrame(page)).toBeLessThan(250);
});

test("adding a bundled sfx while playing mutes the Player and keeps the frame", async ({
  page,
}) => {
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await page.getByRole("button", {name: "Play video"}).click();
  await expect.poll(() => currentFrame(page), {timeout: 10_000}).toBeGreaterThan(8);

  const frameBefore = await currentFrame(page);

  await importYaml(page, "audio.yaml", AUDIO_YAML);
  await expect(volumeButton(page)).toHaveAttribute("aria-label", "Unmute sound");
  await expect(page.locator(".preview-frame")).toHaveAttribute(
    "data-tora-muted",
    "true",
  );
  expect(await currentFrame(page)).toBeGreaterThanOrEqual(frameBefore);
});

test("audio -> no audio -> audio mutes again and no audible start happens until the user unmutes", async ({
  page,
}) => {
  await page.addInitScript(installAudioSpy);
  await openWithAudio(page);

  // The user unmutes and plays: audio really starts (positive control).
  await volumeButton(page).click();
  await expect(volumeButton(page)).toHaveAttribute("aria-label", "Mute sound");
  await page.getByRole("button", {name: "Play video"}).click();
  await expect
    .poll(
      async () =>
        (await auditAfter(page, 0)).starts.filter((entry) => !entry.muted).length,
      {timeout: 10_000},
    )
    .toBeGreaterThan(0);

  const frameBefore = await currentFrame(page);

  await importYaml(page, "silent.yaml", SILENT_YAML);
  await expect(volumeButton(page)).toHaveCount(0);
  await expect(page.locator(".preview-frame")).toHaveAttribute(
    "data-tora-audio-armed",
    "false",
  );

  const transition = await markNow(page);

  await importYaml(page, "audio.yaml", AUDIO_YAML);
  await expect(volumeButton(page)).toHaveAttribute("aria-label", "Unmute sound");
  await expect(page.locator(".preview-frame")).toHaveAttribute(
    "data-tora-muted",
    "true",
  );
  const remountFrame = await currentFrame(page);

  expect(remountFrame).toBeGreaterThanOrEqual(frameBefore);

  // Playback keeps running while muted: wait until it has crossed at least two
  // ding boundaries (one ding per 1 s scene, 30 fps), so the window below
  // really contains scene starts that would have been audible.
  await expect
    .poll(() => currentFrame(page), {timeout: 10_000})
    .toBeGreaterThanOrEqual(remountFrame + 75);

  const muted = await auditAfter(page, transition);

  expect(muted.muteChanges.map((entry) => entry.value)).toContain("true");

  const mutedAt = muted.muteChanges.find((entry) => entry.value === "true").t;

  // An empty list is the expected result: @remotion/media starts no audio
  // while the Player is muted. The checks below only fail if something starts.
  for (const start of muted.starts) {
    expect(start.muted, `${start.kind} at ${start.t}`).toBe(true);
    expect(start.t).toBeGreaterThanOrEqual(mutedAt);
  }

  expect(muted.starts.every((start) => start.muted)).toBe(true);

  // Only the user's click makes it audible again.
  const beforeUnmute = await markNow(page);

  await volumeButton(page).click();
  await expect(volumeButton(page)).toHaveAttribute("aria-label", "Mute sound");
  await expect
    .poll(
      async () =>
        (await auditAfter(page, beforeUnmute)).starts.filter(
          (entry) => !entry.muted,
        ).length,
      {timeout: 10_000},
    )
    .toBeGreaterThan(0);
});

test("the Player restores a valid stored volume and persists a changed one", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("tora.playerVolume", "0.4");
  });
  await openWithAudio(page);
  await volumeButton(page).click();
  await volumeButton(page).hover();

  const slider = page.locator('.preview-frame input[aria-label="Change volume"]');

  await expect(slider).toHaveValue("0.4");

  await slider.fill("0.2");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("tora.playerVolume")))
    .toBe("0.2");
});

test("a garbage stored volume falls back to full volume", async ({page}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("tora.playerVolume", "banana");
  });
  await openWithAudio(page);
  await volumeButton(page).click();
  await volumeButton(page).hover();

  await expect(
    page.locator('.preview-frame input[aria-label="Change volume"]'),
  ).toHaveValue("1");
});

test("a stored Story with audio restores muted after a reload", async ({page}) => {
  await openWithAudio(page);
  await volumeButton(page).click();
  await expect(volumeButton(page)).toHaveAttribute("aria-label", "Mute sound");

  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem("tora-video-engine:project");

        return raw === null
          ? null
          : JSON.parse(raw).story?.scenes?.[0]?.sfx?.src ?? null;
      }),
    )
    .toBe("ding");

  await page.reload({waitUntil: "domcontentloaded"});

  await expect(volumeButton(page)).toHaveAttribute("aria-label", "Unmute sound");
  await expect(page.locator(".preview-frame")).toHaveAttribute(
    "data-tora-muted",
    "true",
  );
  await expect(page.locator(".preview-frame")).toHaveAttribute(
    "data-tora-audio-armed",
    "true",
  );
});
