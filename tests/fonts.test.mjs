import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  isCaptionTextSupported,
  loadCaptionFontForText,
  REQUIRED_FONT_WEIGHTS,
} from "../src/fontCoverage.ts";

describe("caption font coverage", () => {
  it("accepts characters from bundled Latin, Greek, and Cyrillic ranges", () => {
    assert.equal(
      isCaptionTextSupported(
        "Tora café — Καλημέρα — Привет 123 €",
      ),
      true,
    );
  });

  it("rejects Arabic-Indic digits and emoji before rendering", () => {
    assert.equal(isCaptionTextSupported("A٠"), false);
    assert.equal(isCaptionTextSupported("Tora 😀"), false);
  });

  it("loads the full caption text once per required weight", async () => {
    const calls = [];

    await loadCaptionFontForText("AЖ A", async (font, text) => {
      calls.push([font, text]);
      return [{}];
    });

    assert.equal(calls.length, REQUIRED_FONT_WEIGHTS.length);
    assert.deepEqual(
      calls.map(([, text]) => text),
      REQUIRED_FONT_WEIGHTS.map(() => "AЖ A"),
    );
  });

  it("keeps near-maximum caption loading bounded by font weights", async () => {
    const supportedCharacters =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" +
      "ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝßŒœЖЙФΨΩ€—";
    const captionText = Array.from({length: 200}, (_, index) =>
      supportedCharacters.slice(index % 20, (index % 20) + 40),
    ).join("\n");
    const calls = [];

    await loadCaptionFontForText(captionText, async (font, text) => {
      calls.push([font, text]);
      return [{}];
    });

    assert.equal(calls.length, REQUIRED_FONT_WEIGHTS.length);
    assert.ok(calls.every(([, text]) => text === captionText));
  });

  it("does not call the browser loader for unsupported text", async () => {
    let calls = 0;

    await assert.rejects(
      () =>
        loadCaptionFontForText("A٠", async () => {
          calls += 1;
          return [{}];
        }),
      /U\+0660/,
    );

    assert.equal(calls, 0);
  });

  it("still fails if a required font weight cannot load the caption", async () => {
    await assert.rejects(
      () =>
        loadCaptionFontForText("AЖ", async (font) =>
          font.startsWith("800 ") ? [] : [{}],
        ),
      /weight 800/,
    );
  });
});
