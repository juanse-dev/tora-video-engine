import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {loadCaptionFontForText} from "../src/fonts.ts";

describe("caption font loading", () => {
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

  it("rejects a code point not covered by the bundled font", async () => {
    await assert.rejects(
      () =>
        loadCaptionFontForText("A٠", async (_font, text) =>
          text === "٠" ? [] : [{}],
        ),
      /U\+0660/,
    );
  });

  it("checks an astral character as one code point", async () => {
    const checked = [];

    await loadCaptionFontForText("😀", async (_font, text) => {
      checked.push(text);
      return [{}];
    });

    assert.deepEqual(checked, ["😀", "😀", "😀"]);
  });
});
