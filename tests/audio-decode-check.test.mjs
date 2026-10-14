import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {isDecodeComplete} from "../src/audio/decodeCheck.ts";

describe("isDecodeComplete (D-9)", () => {
  it("a 0.12 s clip: nothing decoded fails, 0.05 fails, 0.11 passes", () => {
    assert.equal(isDecodeComplete(0, 0.12), false);
    assert.equal(isDecodeComplete(0.05, 0.12), false);
    assert.equal(isDecodeComplete(0.11, 0.12), true);
  });

  it("a 10 s file: 9.8 passes, 9.7 and 6.0 fail, the boundary 9.75 passes", () => {
    assert.equal(isDecodeComplete(9.8, 10), true);
    assert.equal(isDecodeComplete(9.7, 10), false);
    assert.equal(isDecodeComplete(6, 10), false);
    assert.equal(isDecodeComplete(9.75, 10), true);
    assert.equal(isDecodeComplete(10, 10), true);
    assert.equal(isDecodeComplete(10.5, 10), true);
  });

  it("zero decoded samples always fail, even for a 0.4 s file and a sub-frame one", () => {
    assert.equal(isDecodeComplete(0, 0.4), false);
    assert.equal(isDecodeComplete(0, 0.005), false);
    assert.equal(isDecodeComplete(0.003, 0.005), true);
    assert.equal(isDecodeComplete(0.002, 0.005), false);
  });

  it("never passes a non-finite or negative decoded length", () => {
    assert.equal(isDecodeComplete(Number.NaN, 10), false);
    assert.equal(isDecodeComplete(-1, 10), false);
  });
});
