import assert from "node:assert/strict";
import {readFileSync, readdirSync, statSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import * as storyAudio from "../src/audio/storyAudio.ts";

// Node cannot import .tsx, so App's wiring is pinned as source contracts (the
// pure parts it calls are unit-tested in their own files, and the behavior in
// tests/browser/audio-rendering.spec.mjs under system Chrome).
const app = readFileSync("src/web/App.tsx", "utf8");
const walk = (directory) =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);

    return statSync(path).isDirectory() ? walk(path) : [path];
  });

describe("App renders Stories with audio (AUDIO-005 task 5)", () => {
  it("the AUDIO-001 interim block is gone everywhere", () => {
    assert.equal("AUDIO_RENDER_BLOCK_MESSAGE" in storyAudio, false);

    const sources = [...walk("src"), ...walk("scripts")].filter((path) =>
      /\.(ts|tsx)$/u.test(path),
    );

    for (const path of sources) {
      const text = readFileSync(path, "utf8");

      assert.doesNotMatch(text, /AUDIO_RENDER_BLOCK_MESSAGE|bypassAudioBlockForTest|data-audio-block/u, path);
      assert.doesNotMatch(text, /cannot be rendered yet/u, path);
    }

    assert.doesNotMatch(app, /audioRenderBlock = storyHasAudio/u);
  });

  it("the audio block comes from the readiness function over the page's own inputs and the store's snapshot", () => {
    // App reads the store once (AUDIO-004's `bundledStates`) and feeds that snapshot to readiness.
    assert.equal((app.match(/useBundledAudioStates\(\)/gu) ?? []).length, 1);
    assert.match(app, /evaluateAudioRenderReadiness\(\{\s*story: activeStory,\s*audioDurations,\s*localState: localAssets\.state,\s*bundledStates,\s*\}\)/u);
    // The click never builds a source map for readiness: the button reads the block.
    assert.match(app, /audioRenderBlock !== null \|\|\s*localAssetRenderBlock !== null/u);
  });

  it("the local-asset gate is any local ref, images or audio", () => {
    assert.match(app, /const hasLocalRefs = storyHasAnyLocalAssetRef\(snapshot\)/u);
    assert.doesNotMatch(app, /storyHasLocalAssetRefs/u);
  });

  it("a Story with audio gets the audio preparation around the local one, with the store's snapshot taken at the click", () => {
    assert.match(app, /if \(storyHasAudio\(snapshot\)\) \{[\s\S]*?createAudioRenderPreparation\(\{[\s\S]*?resolved: resolvedLocalAssets,[\s\S]*?prepareLocal: prepareLocalAssets \?\? null,[\s\S]*?getBundledStates: getBundledAudioStates,[\s\S]*?decodeCache: audioDecodeCache,[\s\S]*?\}\);\s*\}\s*const outcome = await startBrowserRenderTransaction\(/u);
  });

  it("the banner says Checking audio while the sources are inspected and decoded", () => {
    assert.match(app, /onStatus: \(message\) =>\s*setRenderUi/u);
  });

  it("the decode cache is invalidated at the same two moments as the integrity cache", () => {
    assert.equal(
      (app.match(/integrityCache\.invalidate\(message\.digests\);\s*audioDecodeCache\.invalidate\(message\.digests\);/gu) ?? []).length,
      2,
    );
  });

  it("the capability is probed per storyHasAudio value and shown whatever its kind", () => {
    assert.match(app, /createRenderCapabilityCache\(\(\{hasAudio\}\) =>\s*checkBrowserRenderCapability\(\{hasAudio\}\)/u);
    assert.match(app, /capabilityCache\.get\(storyUsesAudio\)/u);
    assert.match(app, /renderCapability\.kind !== "ready"\s*\?\s*renderCapability\.message/u);
    assert.doesNotMatch(app, /setRenderCapability\(/u);
  });

  it("the render click checks the capability through the page's cache, for silent and audio Stories alike", () => {
    assert.match(app, /startBrowserRenderTransaction\(snapshot, \{[\s\S]*?checkCapability: \(\) =>\s*capabilityCache\.get\(storyHasAudio\(snapshot\)\),/u);
    // Never conditional on the Story having audio, and never a second probe path.
    assert.equal((app.match(/checkCapability:/gu) ?? []).length, 1);
    assert.equal((app.match(/checkBrowserRenderCapability\(/gu) ?? []).length, 1);
  });

  it("the banner names a local-asset problem before an audio one", () => {
    const local = app.indexOf("? localAssetRenderBlock");
    const audio = app.indexOf("? audioRenderBlock");

    assert.ok(local > 0 && audio > local);
  });
});
