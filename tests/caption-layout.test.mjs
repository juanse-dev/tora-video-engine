import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  CAPTION_MIN_FONT_SIZE,
  CAPTION_TEXT_MAX_HEIGHT,
  estimateCaptionHeight,
  estimateCaptionLineCount,
  getCaptionFontSize,
} from "../src/captionLayout.ts";
import {MAX_CAPTION_LENGTH} from "../src/story/constraints.ts";

describe("caption layout", () => {
  for (const variant of ["hero", "dialogue", "impact"]) {
    it(`fits the longest accepted ${variant} caption`, () => {
      const text = "W".repeat(MAX_CAPTION_LENGTH);
      const fontSize = getCaptionFontSize(variant, text);

      assert.ok(fontSize >= CAPTION_MIN_FONT_SIZE);
      assert.ok(
        estimateCaptionHeight(text, variant, fontSize) <=
          CAPTION_TEXT_MAX_HEIGHT,
      );
    });
  }

  it("accounts conservatively for word-boundary wrapping", () => {
    const text = Array(16).fill("WWWWWWWWWW").join(" ");
    assert.equal(text.length, 175);

    const fontSize = getCaptionFontSize("impact", text);
    const lineCount = estimateCaptionLineCount(
      text,
      "impact",
      fontSize,
    );

    assert.ok(lineCount >= 8);
    assert.ok(
      estimateCaptionHeight(text, "impact", fontSize) <=
        CAPTION_TEXT_MAX_HEIGHT,
    );
  });

  it("keeps short captions larger than the minimum", () => {
    assert.ok(
      getCaptionFontSize("hero", "Short caption") >
        CAPTION_MIN_FONT_SIZE,
    );
  });
});
