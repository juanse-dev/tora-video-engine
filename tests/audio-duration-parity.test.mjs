import assert from "node:assert/strict";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, describe, it} from "node:test";
import {prepareCliAudio} from "../scripts/audioRender.ts";
import {stageLocalAssetsForStory} from "../scripts/localAssets.ts";
import {storyAudioDurations} from "../src/audio/storyAudio.ts";
import {audioMimeTypeFor, inspectAudio} from "../src/localAssets/audioInspection.ts";
import {sha256Hex} from "../src/localAssets/hash.ts";
import {buildLocalAssetRef} from "../src/localAssets/refs.ts";
import {compileTimeline} from "../src/story/timeline.ts";
import {IntegrityCache} from "../src/web/assetLibrary/integrity.ts";
import {evaluateAudioRenderReadiness} from "../src/web/audioRenderReadiness.ts";
import {resolveStoryLocalAssets} from "../src/web/localAssetState.ts";
import {fixtureBytes} from "./helpers/audioBytes.mjs";
import {createMemoryAssetStore} from "./helpers/memoryAssetStore.mjs";

// AINV-3: one duration per ref everywhere. One fixture Story and one set of
// inspected durations feed the browser readiness and the CLI props, and the two
// must agree (so `duration: auto` has the same length in both renders).

const directories = [];

after(async () => {
  for (const directory of directories) {
    await rm(directory, {recursive: true, force: true});
  }
});

describe("browser readiness and the CLI props use the same durations", () => {
  it("a Story with an imported voice (auto length) and a bundled sfx gets identical audioDurations and the same total frames", async () => {
    const bytes = fixtureBytes("tone-440-2.2s.wav");
    const digest = await sha256Hex(bytes);
    const ref = buildLocalAssetRef("audio", digest);
    const inspected = await inspectAudio(bytes);

    assert.equal(inspected.ok, true);

    const story = {
      title: "Parity",
      scenes: [
        {
          type: "intro",
          pose: "formal",
          background: "office",
          text: "One",
          sfx: {src: "ding"},
          voice: {src: ref},
          duration: "auto",
        },
      ],
    };

    // The browser: the library holds the file; the page resolves, verifies and reads its duration.
    const store = createMemoryAssetStore();
    const {container, codec, durationSeconds, sampleRate, channels} = inspected.metadata;

    store.setRaw("assets", ref, {
      label: "Voice",
      originalFilename: "voice.wav",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    store.setRaw("payloadMeta", digest, {
      kind: "audio",
      mimeType: audioMimeTypeFor(container),
      byteSize: bytes.length,
      container,
      codec,
      durationSeconds,
      sampleRate,
      channels,
    });
    store.setRaw("blobs", digest, {blob: new Blob([bytes])});

    const localState = await resolveStoryLocalAssets(story, {kind: "ready", store}, new IntegrityCache());
    const pageMap = storyAudioDurations(story, {[ref]: inspected.metadata.durationSeconds});
    const readiness = evaluateAudioRenderReadiness({
      story,
      audioDurations: pageMap,
      localState,
      bundledStates: new Map([["ding", {kind: "ready"}]]),
    });

    assert.equal(readiness.block, null);

    // The CLI: the same file in local-assets/audio/, measured with the same inspectAudio.
    const root = await mkdtemp(join(tmpdir(), "tora-parity-root-"));
    const publicDir = await mkdtemp(join(tmpdir(), "tora-parity-public-"));

    directories.push(root, publicDir);
    await mkdir(join(root, "audio"));
    await writeFile(join(root, "audio", "any-name.wav"), bytes);

    const staged = await stageLocalAssetsForStory(story, {root, publicDir});
    const cli = await prepareCliAudio(story, {publicDir, localSources: staged.sources});

    assert.deepEqual(cli.audioDurations, {ding: 1.8, [ref]: 2.2});
    assert.deepEqual(readiness.audioDurations, cli.audioDurations);
    assert.deepEqual(pageMap, cli.audioDurations);
    assert.equal(
      compileTimeline(story, 30, readiness.audioDurations).durationInFrames,
      compileTimeline(story, 30, cli.audioDurations).durationInFrames,
    );
    // ceil((2.2 + 0.5) x 30) frames.
    assert.equal(compileTimeline(story, 30, cli.audioDurations).durationInFrames, 81);
  });
});
