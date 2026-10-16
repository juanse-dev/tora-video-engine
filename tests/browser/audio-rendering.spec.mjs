import {expect, test} from "@playwright/test";
import {
  assertAacLcStereoStream,
  assertIntegrationEnvelope,
  INTEGRATION_FRAMES,
  INTEGRATION_VOICE_FIXTURE,
  integrationStoryYaml,
} from "../helpers/audioIntegration.mjs";
import {decodeMp4AudioMono, goertzelWindows} from "../helpers/audioEnvelope.mjs";
import {probeMp4, probeStreams} from "../helpers/ffmpeg.mjs";
import {
  applyYaml,
  isBrowserRenderSupported,
  listRemotionOpfsEntries,
  openSeeded,
  waitForOwner,
} from "./helpers/localAssetPage.mjs";
import {
  audioWavRecord,
  deleteAssetRows,
  truncatedMp3Record,
} from "./helpers/seedAssetLibrary.mjs";

// Browser MP4 render with audio (AUDIO-005). It needs H.264 and AAC encoding,
// which bundled Chromium cannot do, so this file runs under system Chrome
// (playwright.browser-render.config.mjs) and skips itself where rendering is
// unavailable.

const renderButton = (page) => page.getByRole("button", {name: "Render MP4"});
const banner = (page) => page.locator(".render-banner");

/**
 * Whether this Chrome encodes AAC natively (Windows, macOS). Where it does not
 * (the ubuntu Chrome of CI), the web renderer registers its WASM encoder, which
 * ignores the requested bitrate (D-13, accepted): the 128 kb/s range is then not asserted.
 */
const encodesAacNatively = (page) =>
  page.evaluate(
    async () =>
      (
        await AudioEncoder.isConfigSupported({
          codec: "mp4a.40.2",
          sampleRate: 48_000,
          numberOfChannels: 2,
          bitrate: 128_000,
        })
      ).supported,
  );

const requireRenderSupport = async (page) => {
  // A failure, not a skip: these specs are the only proof of the real audio render (as in render-cancel-cleanup).
  expect(
    await isBrowserRenderSupported(page),
    "Browser MP4 rendering must be ready in this runtime",
  ).toBe(true);
};

const storyYaml = (scenes, title = "Audio render") =>
  [
    `title: ${title}`,
    "scenes:",
    ...scenes.flatMap(({sfx, voice, duration = 2}) => [
      "  - type: intro",
      "    pose: formal",
      "    background: office",
      "    animation: fade",
      '    text: "Audio render."',
      ...(sfx === undefined ? [] : ["    sfx:", `      src: ${sfx}`]),
      ...(voice === undefined ? [] : ["    voice:", `      src: ${voice}`]),
      `    duration: ${duration}`,
    ]),
    "",
  ].join("\n");

/** Records every fetch of the page (init script), so a render's sources can be told apart. */
const recordFetches = (page) =>
  page.addInitScript(() => {
    window.__fetchedUrls = [];

    const original = window.fetch.bind(window);

    window.fetch = (input, init) => {
      window.__fetchedUrls.push(String(input instanceof Request ? input.url : input));

      return original(input, init);
    };
  });
const fetchedUrls = (page) => page.evaluate(() => window.__fetchedUrls);

const renderAndDownload = async (page, timeout = 200_000) => {
  const downloadPromise = page.waitForEvent("download", {timeout});

  await renderButton(page).click();

  const download = await downloadPromise;
  const path = await download.path();

  if (path === null) {
    throw new Error("Expected a browser MP4 download path");
  }

  await expect(page.locator(".app-shell")).toHaveAttribute("data-render-state", "success", {
    timeout: 60_000,
  });

  return path;
};

test("a Story with a bundled sfx enables Render by itself, renders it through object URLs and downloads one AAC-LC 48 kHz stereo track", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const dingRequests = [];
  let releaseDing = () => undefined;
  const dingGate = new Promise((resolve) => {
    releaseDing = resolve;
  });

  await recordFetches(page);
  await page.route("**/audio/sfx/ding.wav", async (route) => {
    await dingGate;
    await route.continue();
  });
  page.on("request", (request) => {
    if (request.url().endsWith("/audio/sfx/ding.wav")) {
      dingRequests.push(request.url());
    }
  });

  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await requireRenderSupport(page);
  await applyYaml(page, storyYaml([{sfx: "ding"}, {}]));

  // The sound is still loading: Render is blocked with the reason and nothing is prepared.
  await expect(renderButton(page)).toBeDisabled();
  await expect(banner(page)).toContainText("Audio is still loading.");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-render-state", "idle");

  // The store's check succeeds: Render enables with no other interaction.
  releaseDing();
  await expect(renderButton(page)).toBeEnabled({timeout: 20_000});
  await expect(banner(page)).not.toContainText("Audio is still loading.");

  const requestsBefore = dingRequests.length;
  const fetchesBefore = (await fetchedUrls(page)).length;
  const path = await renderAndDownload(page);

  // The renderer reads render-owned object URLs, never the file on the server.
  expect(dingRequests.length).toBe(requestsBefore);

  const duringRender = (await fetchedUrls(page)).slice(fetchesBefore);

  expect(duringRender.some((url) => url.startsWith("blob:"))).toBe(true);
  expect(duringRender.some((url) => url.includes("/audio/sfx/"))).toBe(false);

  const streams = await probeStreams(path);
  const video = streams.filter((stream) => stream.codec_type === "video");
  const audio = streams.filter((stream) => stream.codec_type === "audio");

  expect(video).toHaveLength(1);
  expect(video[0].codec_name).toBe("h264");
  expect(Number(video[0].nb_frames)).toBe(120);
  expect(audio).toHaveLength(1);
  assertAacLcStereoStream(audio[0], "browser render", {
    bitrate: await encodesAacNatively(page),
  });

  // The ding is audible at the start and gone later (positive control + silence).
  const samples = await decodeMp4AudioMono(path);
  const ding = goertzelWindows(samples, 880, 100);

  expect(ding[0]).toBeGreaterThan(0.02);
  expect(Math.max(...ding.slice(20))).toBeLessThan(0.01);
  expect(await listRemotionOpfsEntries(page)).toEqual([]);
});

test("a Story without audio still produces a video-only MP4", async ({page}) => {
  test.setTimeout(180_000);

  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await requireRenderSupport(page);
  await applyYaml(page, storyYaml([{duration: 1}], "Silent render"));
  await expect(renderButton(page)).toBeEnabled();

  const path = await renderAndDownload(page);
  const info = await probeMp4(path);

  expect(info.hasAudio).toBe(false);
  expect(info.videoStreams).toBe(1);
  expect(info.codec).toBe("h264");
  expect(info.frames).toBe(30);
});

test("without a native AAC encoder the WASM encoder renders and the file passes the check", async ({
  page,
}) => {
  test.setTimeout(240_000);

  // The browser says it cannot encode AAC, so the web renderer registers its
  // WASM encoder (D-13). MEASURED (Chrome 155, @remotion/web-renderer 4.0.529):
  // it writes AAC-LC 48 kHz stereo but ignores the requested bitrate (67 kb/s
  // for the ding story, 89 kb/s for the integration story); that is accepted, so
  // the post-render check does not look at the bitrate and the render succeeds.
  await page.addInitScript(() => {
    const original = AudioEncoder.isConfigSupported.bind(AudioEncoder);

    AudioEncoder.isConfigSupported = async (config) =>
      String(config.codec).startsWith("mp4a")
        ? {supported: false, config}
        : original(config);
  });
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await requireRenderSupport(page);
  await applyYaml(page, storyYaml([{sfx: "ding", duration: 2}], "Wasm AAC"));
  await expect(renderButton(page)).toBeEnabled({timeout: 30_000});

  const path = await renderAndDownload(page);
  const audio = (await probeStreams(path)).filter((stream) => stream.codec_type === "audio");

  expect(audio).toHaveLength(1);
  assertAacLcStereoStream(audio[0], "wasm aac", {bitrate: false});

  // The sound is really there (positive control).
  const ding = goertzelWindows(await decodeMp4AudioMono(path), 880, 100);

  expect(ding[0]).toBeGreaterThan(0.02);
  expect(await listRemotionOpfsEntries(page)).toEqual([]);
});

test("a Story whose local voice was deleted cannot render", async ({page}) => {
  test.setTimeout(120_000);

  const voice = await audioWavRecord(INTEGRATION_VOICE_FIXTURE, {label: "Voice take"});

  await openSeeded(page, [voice]);
  await requireRenderSupport(page);
  await applyYaml(page, storyYaml([{voice: voice.ref, duration: 3}], "Deleted voice"));
  await expect(renderButton(page)).toBeEnabled({timeout: 20_000});

  await deleteAssetRows(page, [voice.ref]);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect(renderButton(page)).toBeDisabled();
  await expect(banner(page)).toContainText(
    "Browser render is blocked because 1 audio file(s) are unavailable in this browser.",
  );
});

test("a seeded local audio file whose metadata parses but whose samples do not decode fails the preflight before OPFS is touched", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const truncated = await truncatedMp3Record({label: "Truncated take"});

  await openSeeded(page, [truncated]);
  await requireRenderSupport(page);
  await applyYaml(page, storyYaml([{voice: truncated.ref, duration: 3}], "Truncated voice"));
  // Readiness does not decode: the metadata is readable, so the button is enabled.
  await expect(renderButton(page)).toBeEnabled({timeout: 20_000});

  const started = Date.now();

  await renderButton(page).click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-render-state", "failure", {
    timeout: 15_000,
  });
  await expect(banner(page)).toContainText(
    "Browser render failed: Audio file Truncated take cannot be used for rendering.",
  );

  // Quickly, not after a stalled render, with nothing left behind and authoring unlocked.
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(await listRemotionOpfsEntries(page)).toEqual([]);
  await expect(page.locator(".app-shell")).toHaveAttribute("data-authoring-locked", "false");
});

test("an imported voice and a bundled ding render together in the browser: 440 Hz during the voice and the ding at its onset", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const voice = await audioWavRecord(INTEGRATION_VOICE_FIXTURE, {label: "Voice take"});

  await recordFetches(page);
  await openSeeded(page, [voice]);
  await requireRenderSupport(page);
  await applyYaml(page, integrationStoryYaml(voice.ref));
  await expect(renderButton(page)).toBeEnabled({timeout: 30_000});

  const fetchesBefore = (await fetchedUrls(page)).length;
  const path = await renderAndDownload(page);

  // A lease blob: URL for the voice and a render-owned blob: URL for ding: two different objects, no server fetch.
  const duringRender = (await fetchedUrls(page)).slice(fetchesBefore);
  const blobUrls = new Set(duringRender.filter((url) => url.startsWith("blob:")));

  expect(blobUrls.size).toBeGreaterThanOrEqual(2);
  expect(duringRender.some((url) => url.includes("/audio/sfx/"))).toBe(false);

  const info = await probeMp4(path);

  expect(info.frames).toBe(INTEGRATION_FRAMES);
  assertIntegrationEnvelope(await decodeMp4AudioMono(path), "browser render");
});

const dingStory = () => storyYaml([{sfx: "ding", duration: 2}], "Ding readiness");
const DING = "**/audio/sfx/ding.wav";

test("a ding.wav that cannot be decoded blocks Render with the readiness message as soon as the decode fails, and no render starts", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.route(DING, (route) =>
    route.fulfill({status: 200, contentType: "audio/wav", body: Buffer.from("RIFF not really a wav")}),
  );
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await requireRenderSupport(page);
  await applyYaml(page, dingStory());

  await expect(banner(page)).toContainText("Audio file ding cannot be used for rendering.", {
    timeout: 15_000,
  });
  await expect(renderButton(page)).toBeDisabled();
  // No other interaction, and nothing was started.
  await expect(page.locator(".app-shell")).toHaveAttribute("data-render-state", "idle");
  expect(await listRemotionOpfsEntries(page)).toEqual([]);
});

test("a first network failure of ding.wav is retried by itself and Render enables without a reload", async ({
  page,
}) => {
  test.setTimeout(120_000);

  let requests = 0;

  await page.route(DING, (route) => {
    requests += 1;

    return requests === 1 ? route.abort("failed") : route.continue();
  });
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await requireRenderSupport(page);
  await applyYaml(page, dingStory());

  // The first request fails; the store retries after 1 s with no navigation, select or Story change.
  await expect(renderButton(page)).toBeEnabled({timeout: 20_000});
  await expect(banner(page)).not.toContainText("Audio");
  expect(requests).toBeGreaterThanOrEqual(2);
});

test("when every request for ding.wav fails, Retry loading Ding appears and clicking it after the route is fixed enables Render", async ({
  page,
}) => {
  test.setTimeout(120_000);

  let failing = true;

  await page.route(DING, (route) => (failing ? route.abort("failed") : route.continue()));
  await page.goto("/", {waitUntil: "domcontentloaded"});
  await waitForOwner(page);
  await requireRenderSupport(page);
  await applyYaml(page, dingStory());

  // The Retry button belongs to the Sound effect field of the visual editor.
  await page.getByRole("button", {name: "Open visual editor"}).click();

  // 1 s + 2 s + 4 s of automatic retries, then the manual one.
  const retry = page.getByRole("button", {name: "Retry loading Ding"});

  await expect(retry).toBeVisible({timeout: 30_000});
  await expect(banner(page)).toContainText("Audio could not be loaded. Retry it in the editor.");
  await expect(renderButton(page)).toBeDisabled();

  failing = false;
  await retry.click();
  await expect(renderButton(page)).toBeEnabled({timeout: 20_000});
  await expect(banner(page)).not.toContainText("Audio");
});

test("during an actual render of an audio Story the editor is locked: every audio control, the My audio controls and Caption are disabled", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const voice = await audioWavRecord(INTEGRATION_VOICE_FIXTURE, {label: "Voice take"});

  await openSeeded(page, [voice]);
  await requireRenderSupport(page);
  await applyYaml(
    page,
    [
      "title: Locked render",
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
      `      src: ${voice.ref}`,
      "    duration: 12",
      "",
    ].join("\n"),
  );
  await page.getByRole("button", {name: "Open visual editor"}).click();

  const controls = [
    page.getByLabel("Caption"),
    page.getByRole("combobox", {name: "Music", exact: true}),
    page.getByLabel("Music volume"),
    page.getByLabel("Music ducking"),
    page.getByLabel("Fade in (seconds)"),
    page.getByLabel("Fade out (seconds)"),
    page.getByRole("combobox", {name: "Sound effect", exact: true}),
    page.getByLabel("Sound effect volume"),
    page.getByRole("combobox", {name: "Voice", exact: true}),
    page.getByLabel("Voice volume"),
    page.getByLabel("Auto (from voice)"),
    page.locator('[data-my-audio] input[type="file"]'),
    page.getByRole("button", {name: "Play Voice take"}),
  ];

  await expect(renderButton(page)).toBeEnabled({timeout: 30_000});

  // Positive control: enabled before the render.
  for (const control of controls) {
    await expect(control).toBeEnabled();
  }

  const downloadPromise = page.waitForEvent("download", {timeout: 200_000});

  await renderButton(page).click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-authoring-locked", "true", {
    timeout: 30_000,
  });

  for (const control of controls) {
    await expect(control).toBeDisabled();
  }

  await downloadPromise;
  await expect(page.locator(".app-shell")).toHaveAttribute("data-render-state", "success", {
    timeout: 60_000,
  });
  await expect(page.locator(".app-shell")).toHaveAttribute("data-authoring-locked", "false");

  for (const control of controls) {
    await expect(control).toBeEnabled();
  }
});
