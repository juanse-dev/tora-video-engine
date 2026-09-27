import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  captionCodePointLength,
  MAX_CAPTION_LENGTH,
} from "../src/story/constraints.ts";

describe("caption constraints", () => {
  it("counts astral Unicode as one code point", () => {
    assert.equal(captionCodePointLength("😀".repeat(91)), 91);
    assert.ok(
      captionCodePointLength("😀".repeat(91)) <= MAX_CAPTION_LENGTH,
    );
  });
});
