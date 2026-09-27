import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  captionCodePointLength,
  hasOnlySupportedCaptionCharacters,
  MAX_CAPTION_LENGTH,
} from "../src/story/constraints.ts";

describe("caption constraints", () => {
  it("counts astral Unicode as one code point", () => {
    assert.equal(captionCodePointLength("😀".repeat(91)), 91);
    assert.ok(
      captionCodePointLength("😀".repeat(91)) <= MAX_CAPTION_LENGTH,
    );
  });

  it("supports the scripts bundled with the MVP caption font", () => {
    assert.equal(
      hasOnlySupportedCaptionCharacters(
        "Tora café — Καλημέρα — Привет 123",
      ),
      true,
    );
  });

  it("rejects characters outside the MVP font contract", () => {
    assert.equal(hasOnlySupportedCaptionCharacters("Tora 😀"), false);
  });
});
