import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {createDuckGain, mergeDuckWindows} from "../src/audio/ducking.ts";

const close = (actual, expected, label = "") =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${label} expected ${expected}, got ${actual}`,
  );

describe("mergeDuckWindows", () => {
  it("merges windows closer than the gap and keeps those at the gap", () => {
    // 30 FPS: DUCK_MERGE_GAP_SECONDS = 0.3 s = 9 frames.
    assert.deepEqual(
      mergeDuckWindows([{start: 90, end: 102}, {start: 110, end: 122}], 9),
      [{start: 90, end: 122}],
    );
    assert.deepEqual(
      mergeDuckWindows([{start: 90, end: 102}, {start: 111, end: 123}], 9),
      [{start: 90, end: 102}, {start: 111, end: 123}],
    );
  });

  it("sorts its input, merges overlapping and contained windows and leaves the input alone", () => {
    const input = [
      {start: 50, end: 60},
      {start: 0, end: 20},
      {start: 5, end: 10},
      {start: 15, end: 30},
    ];
    const before = structuredClone(input);

    assert.deepEqual(mergeDuckWindows(input, 9), [
      {start: 0, end: 30},
      {start: 50, end: 60},
    ]);
    assert.deepEqual(input, before);
  });

  it("returns no windows for no input", () => {
    assert.deepEqual(mergeDuckWindows([], 9), []);
  });
});

describe("createDuckGain", () => {
  const gain = createDuckGain([{start: 90, end: 102}], {
    duck: 0.35,
    rampFrames: 5,
  });

  it("is 1 outside, exactly duck inside and ramps linearly", () => {
    close(gain(0), 1);
    close(gain(84), 1);
    close(gain(85), 1);
    close(gain(86), 0.87);
    close(gain(89), 0.48);
    close(gain(90), 0.35);
    close(gain(101), 0.35);
    close(gain(102), 0.35);
    close(gain(103), 0.48);
    close(gain(106), 0.87);
    close(gain(107), 1);
    close(gain(500), 1);
  });

  it("is constant 1 with duck 1 or without windows", () => {
    const noDuck = createDuckGain([{start: 90, end: 102}], {
      duck: 1,
      rampFrames: 5,
    });
    const noWindows = createDuckGain([], {duck: 0.35, rampFrames: 5});

    for (const frame of [0, 89, 95, 102, 400]) {
      assert.equal(noDuck(frame), 1);
      assert.equal(noWindows(frame), 1);
    }
  });

  it("goes fully silent inside a window with duck 0", () => {
    const silent = createDuckGain([{start: 10, end: 20}], {
      duck: 0,
      rampFrames: 4,
    });

    assert.equal(silent(10), 0);
    assert.equal(silent(19), 0);
    assert.equal(silent(8), 0.5);
    assert.equal(silent(22), 0.5);
  });

  it("takes the minimum where two ramps overlap", () => {
    // Windows closer than twice the ramp: the trailing ramp of the first
    // (10..20) and the leading ramp of the second (15..25) overlap.
    const overlapping = createDuckGain(
      [
        {start: 0, end: 10},
        {start: 25, end: 40},
      ],
      {duck: 0.35, rampFrames: 10},
    );

    close(overlapping(17), 0.805, "trailing ramp is lower");
    close(overlapping(19), 0.74, "leading ramp is lower");
  });

  it("matches a brute-force minimum over many random windows", () => {
    let seed = 987654321;
    const random = (max) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;

      return Math.floor((seed / 4294967296) * max);
    };
    const windows = [];
    let cursor = 5;

    for (let index = 0; index < 60; index += 1) {
      const start = cursor + random(30);
      const end = start + 1 + random(20);

      windows.push({start, end});
      cursor = end + 1;
    }

    const merged = mergeDuckWindows(windows, 9);
    const rampFrames = 5;
    const duck = 0.35;
    const fast = createDuckGain(merged, {duck, rampFrames});
    const single = (window, frame) => {
      if (frame >= window.start && frame < window.end) return duck;
      if (frame < window.start) {
        return frame >= window.start - rampFrames
          ? 1 - ((1 - duck) * (frame - (window.start - rampFrames))) / rampFrames
          : 1;
      }

      return frame < window.end + rampFrames
        ? duck + ((1 - duck) * (frame - window.end)) / rampFrames
        : 1;
    };

    for (let frame = 0; frame < cursor + 20; frame += 1) {
      const slow = Math.min(1, ...merged.map((window) => single(window, frame)));

      close(fast(frame), slow, `frame ${frame}`);
    }
  });
});
