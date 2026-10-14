import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {maxSimultaneousGain} from "../src/audio/clipping.ts";

const track = (fromFrame, durationInFrames, gain) => ({
  fromFrame,
  durationInFrames,
  gainAt: typeof gain === "function" ? gain : () => gain,
});
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);

describe("maxSimultaneousGain", () => {
  it("is 0 without tracks", () => {
    assert.equal(maxSimultaneousGain([]), 0);
  });

  it("is the gain of a single constant track", () => {
    close(maxSimultaneousGain([track(10, 20, 0.7)]), 0.7);
  });

  it("adds the gains of tracks that overlap", () => {
    close(maxSimultaneousGain([track(0, 10, 0.5), track(5, 10, 0.25)]), 0.75);
  });

  it("does not add tracks that only touch or are far apart", () => {
    close(maxSimultaneousGain([track(0, 5, 0.5), track(5, 5, 0.25)]), 0.5);
    close(maxSimultaneousGain([track(0, 10, 0.5), track(20, 10, 0.9)]), 0.9);
  });

  it("takes the peak of a varying gain, including at the overlap frame", () => {
    const ramp = track(0, 10, (frame) => frame / 10);

    close(maxSimultaneousGain([ramp]), 0.9);
    close(maxSimultaneousGain([ramp, track(9, 1, 0.2)]), 1.1);
  });

  it("does not depend on the order of the tracks", () => {
    const tracks = [track(20, 10, 0.4), track(0, 30, 0.5), track(10, 15, 0.3)];

    close(maxSimultaneousGain(tracks), 1.2);
    close(maxSimultaneousGain([...tracks].reverse()), 1.2);
  });

  it("evaluates each track only inside its own range, once per frame", () => {
    let calls = 0;
    const guarded = (fromFrame, durationInFrames, gain) =>
      track(fromFrame, durationInFrames, (frame) => {
        calls += 1;
        assert.ok(
          frame >= fromFrame && frame < fromFrame + durationInFrames,
          `frame ${frame} outside [${fromFrame}, ${fromFrame + durationInFrames})`,
        );

        return gain;
      });

    maxSimultaneousGain([guarded(0, 108_000, 0.5), guarded(50_000, 30, 0.5)]);
    assert.equal(calls, 108_000 + 30);
  });
});
