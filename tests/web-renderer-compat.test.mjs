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

    assert.match(source, /layoutCaptionLines/);
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

  it("keeps scene layering in DOM order without z-index", async () => {
    const source = await read("src/Scene.tsx");

    assert.equal(source.includes("zIndex"), false);
    assert.match(source, /backgroundColor: preset\.overlay/);
  });
});
