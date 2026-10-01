import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  CAPTION_CONTENT_WIDTH,
  CAPTION_MIN_FONT_SIZE,
  CAPTION_TEXT_MAX_HEIGHT,
  estimateCaptionHeight,
  estimateCaptionLineCount,
  estimateCaptionLineWidth,
  getCaptionFontSize,
  layoutCaptionLines,
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

  it("uses a conservative glyph-width bound independent of words", () => {
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

  it("does not rely on CSS case transformations for impact captions", () => {
    const text = "ﬄ".repeat(MAX_CAPTION_LENGTH);
    const fontSize = getCaptionFontSize("impact", text);

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

  it("wraps natural-language captions into deterministic explicit lines", () => {
    const text =
      "Deploy Friday is fine until the tiny change becomes a very long production incident description.";
    const fontSize = getCaptionFontSize("dialogue", text);
    const first = layoutCaptionLines(text, "dialogue", fontSize);
    const second = layoutCaptionLines(text, "dialogue", fontSize);

    assert.deepEqual(first, second);
    assert.ok(first.length > 1);
    assert.equal(first.join(" ").replace(/\s+/gu, " "), text);
    assert.ok(
      first.every(
        (line) =>
          estimateCaptionLineWidth(line, "dialogue", fontSize) <=
          CAPTION_CONTENT_WIDTH,
      ),
    );
  });

  it("hard-wraps long unbroken tokens without CSS word breaking", () => {
    const text = "W".repeat(MAX_CAPTION_LENGTH);
    const fontSize = getCaptionFontSize("impact", text);
    const lines = layoutCaptionLines(text, "impact", fontSize);

    assert.ok(lines.length > 1);
    assert.equal(lines.join(""), text);
    assert.ok(
      lines.every(
        (line) =>
          estimateCaptionLineWidth(line, "impact", fontSize) <=
          CAPTION_CONTENT_WIDTH,
      ),
    );
  });

  it("uses a conservative bound for wide uppercase glyphs", () => {
    const text = "OQ".repeat(MAX_CAPTION_LENGTH / 2);
    const fontSize = getCaptionFontSize("impact", text);
    const lines = layoutCaptionLines(text, "impact", fontSize);

    assert.ok(
      estimateCaptionLineWidth("O", "impact", 100) >= 100,
    );
    assert.equal(lines.join(""), text);
    assert.ok(
      lines.every(
        (line) =>
          estimateCaptionLineWidth(line, "impact", fontSize) <=
          CAPTION_CONTENT_WIDTH,
      ),
    );
  });

  it("uses a conservative bound for numeric glyphs", () => {
    const shortNumeric = "0".repeat(15);
    const shortLines = layoutCaptionLines(
      shortNumeric,
      "impact",
      92,
    );

    assert.ok(
      estimateCaptionLineWidth("0", "impact", 100) >= 100,
    );
    assert.ok(shortLines.length > 1);
    assert.equal(shortLines.join(""), shortNumeric);

    const text = "0".repeat(MAX_CAPTION_LENGTH);
    const fontSize = getCaptionFontSize("impact", text);
    const lines = layoutCaptionLines(text, "impact", fontSize);

    assert.equal(lines.join(""), text);
    assert.ok(
      lines.every(
        (line) =>
          estimateCaptionLineWidth(line, "impact", fontSize) <=
          CAPTION_CONTENT_WIDTH,
      ),
    );
  });

  it("uses a digit-width bound for figure spaces", () => {
    const text = `A${"\u2007".repeat(20)}A`;
    const lines = layoutCaptionLines(text, "impact", 92);

    assert.ok(
      estimateCaptionLineWidth("\u2007", "impact", 100) >= 100,
    );
    assert.ok(lines.length > 1);
    assert.equal(lines.join(""), text);
    assert.ok(
      lines.every(
        (line) =>
          estimateCaptionLineWidth(line, "impact", 92) <=
          CAPTION_CONTENT_WIDTH,
      ),
    );
  });

  it("uses a conservative bound for wide lowercase glyphs", () => {
    const text = "m".repeat(11);
    const lines = layoutCaptionLines(text, "impact", 92);

    assert.ok(
      estimateCaptionLineWidth("m", "impact", 100) >= 100,
    );
    assert.ok(lines.length > 1);
    assert.equal(lines.join(""), text);
    assert.ok(
      lines.every(
        (line) =>
          estimateCaptionLineWidth(line, "impact", 92) <=
          CAPTION_CONTENT_WIDTH,
      ),
    );
  });

  it("never splits a supported combining sequence across explicit lines", () => {
    const grapheme = "e\u0301";
    const text = grapheme.repeat(MAX_CAPTION_LENGTH / 2);
    const lines = layoutCaptionLines(text, "impact", 92);

    assert.ok(lines.length > 1);
    assert.equal(lines.join(""), text);
    assert.ok(
      lines.every((line) => !/^\p{Mark}/u.test(line)),
    );
  });

  it("preserves every supported no-break whitespace inside caption tokens", () => {
    const fixtures = [
      ["U+00A0", "\u00A0"],
      ["U+2007", "\u2007"],
      ["U+202F", "\u202F"],
      ["U+FEFF", "\uFEFF"],
    ];

    for (const [label, whitespace] of fixtures) {
      const token = `left${whitespace}right`;
      const text = `prefix ${token} suffix`;
      const lines = layoutCaptionLines(text, "dialogue", 60);
      const reconstructed = lines.join(" ");

      assert.equal(
        reconstructed,
        text,
        `${label} must survive caption tokenization unchanged`,
      );
      assert.ok(
        lines.some((line) => line.includes(token)),
        `${label} must not create a token boundary`,
      );
    }
  });
});
