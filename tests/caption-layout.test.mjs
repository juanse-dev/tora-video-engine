import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  CAPTION_MIN_FONT_SIZE,
  CAPTION_TEXT_MAX_HEIGHT,
  estimateCaptionHeight,
  getCaptionFontSize,
} from "../src/captionLayout.ts";
import {MAX_CAPTION_LENGTH} from "../src/story/constraints.ts";

describe("caption layout", () => {
  for (const variant of ["hero", "dialogue", "impact"]) {
    it(`fits the longest accepted ${variant} caption`, () => {
      const fontSize = getCaptionFontSize(
        variant,
        MAX_CAPTION_LENGTH,
      );

      assert.ok(fontSize >= CAPTION_MIN_FONT_SIZE);
      assert.ok(
        estimateCaptionHeight(MAX_CAPTION_LENGTH, fontSize) <=
          CAPTION_TEXT_MAX_HEIGHT,
      );
    });
  }

  it("keeps short captions larger than the minimum", () => {
    assert.ok(
      getCaptionFontSize("hero", 20) > CAPTION_MIN_FONT_SIZE,
    );
  });
});
