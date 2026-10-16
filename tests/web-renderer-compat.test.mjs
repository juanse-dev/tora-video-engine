import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {describe, it} from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("WEB-006 web-renderer compatibility audit", () => {
  it("does not rely on unsupported caption alignment or wrapping styles", async () => {
    const source = await read("src/components/Caption.tsx");

    for (const unsupported of [
      "textAlign",
      "overflowWrap",
      "wordBreak",
      "boxSizing",
    ]) {
      assert.equal(
        source.includes(unsupported),
        false,
        `Caption must not rely on ${unsupported}`,
      );
    }

    assert.match(source, /resolveCaptionLayout/);
    assert.match(source, /data-caption-line/);
  });

  it("uses background-color rather than unsupported background shorthand in the video fallback", async () => {
    const source = await read("src/Video.tsx");

    assert.equal(source.includes("background:"), false);
    assert.match(source, /backgroundColor/);
  });

  it("does not rely on unsupported image object-position", async () => {
    const source = await read("src/components/Tora.tsx");

    assert.equal(source.includes("objectPosition"), false);
  });

  it("keeps the missing-asset placeholder within web-renderer supported styles", async () => {
    const source = await read("src/components/MissingAssetPlaceholder.tsx");

    for (const unsupported of [
      "background:",
      "textAlign",
      "zIndex",
      "objectPosition",
      "boxSizing",
      "overflowWrap",
      "wordBreak",
    ]) {
      assert.equal(
        source.includes(unsupported),
        false,
        `MissingAssetPlaceholder must not rely on ${unsupported}`,
      );
    }

    assert.match(source, /backgroundColor/);
    assert.match(source, /data-missing-local-asset/);
  });

  it("keeps scene layering in DOM order without z-index", async () => {
    const source = await read("src/Scene.tsx");

    assert.equal(source.includes("zIndex"), false);
    assert.match(source, /backgroundColor: preset\.overlay/);
  });

  it("relies on the pinned web-renderer registering its WASM AAC encoder before it decides", async () => {
    // D-13: with no native AAC encoder the page still renders AAC. The capability
    // probe and the render both go through resolveAudioCodec, which awaits the
    // registration; this pins that behavior of exactly @remotion/web-renderer 4.0.529.
    const library = await read("node_modules/@remotion/web-renderer/dist/esm/index.mjs");
    const packageJson = JSON.parse(await read("node_modules/@remotion/web-renderer/package.json"));

    assert.equal(packageJson.version, "4.0.529");
    assert.equal(packageJson.dependencies["@mediabunny/aac-encoder"], "1.56.1");
    assert.match(library, /import\("@mediabunny\/aac-encoder"\)/u);
    const registration = library.indexOf(
      'if (audioCodec === "aac") {\n    await ensureAacEncoderRegistered();',
    );
    const decision = library.indexOf(
      "const canEncode = await canEncodeAudio4(mediabunnyAudioCodec",
    );

    assert.ok(
      registration > 0 && decision > registration,
      "the AAC registration comes before the encode check",
    );
  });
});
