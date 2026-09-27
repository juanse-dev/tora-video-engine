import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  isCaptionTextSupported,
  loadCaptionFontForText,
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

  it("checks every renderable code point against every required weight", async () => {
    const calls = [];

    await loadCaptionFontForText("AЖ A", async (font, text) => {
      calls.push([font, text]);
      return [{}];
    });

    assert.deepEqual(
      calls.map(([, text]) => text),
      ["A", "Ж", "A", "Ж", "A", "Ж"],
    );
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

  it("still fails if a supported bundled glyph cannot be loaded", async () => {
    await assert.rejects(
      () =>
        loadCaptionFontForText("AЖ", async (_font, text) =>
          text === "Ж" ? [] : [{}],
        ),
      /U\+0416/,
    );
  });
});
