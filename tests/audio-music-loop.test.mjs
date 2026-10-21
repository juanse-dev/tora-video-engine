import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  crossfadeFactorAt,
  fadeFactorAt,
  planMusicLoop,
  resolveFades,
} from "../src/audio/musicLoop.ts";

const close = (actual, expected, label = "") =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${label} expected ${expected}, got ${actual}`,
  );
const rows = (loop) =>
  loop.copies.map((copy) => [copy.index, copy.fromFrame, copy.durationInFrames]);

describe("planMusicLoop", () => {
  it("overlaps copies by 0.3 s: starts at k * (300 - 9) and the last copy is truncated", () => {
    const loop = planMusicLoop({musicSeconds: 10, totalFrames: 600, fps: 30});

    assert.equal(loop.crossfadeFrames, 9);
    assert.equal(loop.tooShortToLoop, false);
    assert.deepEqual(rows(loop), [
      [0, 0, 300],
      [1, 291, 300],
      [2, 582, 18],
    ]);
    assert.deepEqual(
      rows(planMusicLoop({musicSeconds: 10, totalFrames: 360, fps: 30})),
      [
        [0, 0, 300],
        [1, 291, 69],
      ],
    );
  });

  it("plays one copy of the Story length when the music is as long or longer", () => {
    assert.deepEqual(
      rows(planMusicLoop({musicSeconds: 10, totalFrames: 300, fps: 30})),
      [[0, 0, 300]],
    );
    assert.deepEqual(
      rows(planMusicLoop({musicSeconds: 10, totalFrames: 150, fps: 30})),
      [[0, 0, 150]],
    );
    assert.equal(
      planMusicLoop({musicSeconds: 10, totalFrames: 150, fps: 30}).crossfadeFrames,
      0,
    );
  });

  it("loops 1.0 s music with X = min(9, 15) = 9 and stride 21", () => {
    const loop = planMusicLoop({musicSeconds: 1, totalFrames: 100, fps: 30});

    assert.equal(loop.crossfadeFrames, 9);
    assert.deepEqual(rows(loop), [
      [0, 0, 30],
      [1, 21, 30],
      [2, 42, 30],
      [3, 63, 30],
      [4, 84, 16],
    ]);
  });

  it("plays music under 1 s once, without a loop", () => {
    const half = planMusicLoop({musicSeconds: 0.5, totalFrames: 100, fps: 30});

    assert.deepEqual(rows(half), [[0, 0, 15]]);
    assert.equal(half.tooShortToLoop, true);
    assert.equal(half.crossfadeFrames, 0);

    // The bundled `pop`: 0.25 s = round(7.5) = 8 frames.
    const pop = planMusicLoop({musicSeconds: 0.25, totalFrames: 90, fps: 30});

    assert.deepEqual(rows(pop), [[0, 0, 8]]);
    assert.equal(pop.tooShortToLoop, true);
  });

  it("does not call music too short when the Story is no longer than it", () => {
    const loop = planMusicLoop({musicSeconds: 0.5, totalFrames: 12, fps: 30});

    assert.deepEqual(rows(loop), [[0, 0, 12]]);
    assert.equal(loop.tooShortToLoop, false);
  });

  it("clamps the crossfade to half the music so every stride is at least 1", () => {
    // A 0.9 s crossfade on 1 s music at 30 FPS asks for 27 frames; only 15 fit.
    const loop = planMusicLoop({
      musicSeconds: 1,
      totalFrames: 100,
      fps: 30,
      crossfadeSeconds: 0.9,
    });

    assert.equal(loop.crossfadeFrames, 15);
    assert.deepEqual(
      loop.copies.map((copy) => copy.fromFrame),
      [0, 15, 30, 45, 60, 75, 90],
    );
  });

  it("covers the Story without gaps and bounds the copy count for random inputs", () => {
    let seed = 24680;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;

      return seed / 4294967296;
    };

    for (let round = 0; round < 300; round += 1) {
      const fps = [24, 30, 60][Math.floor(random() * 3)];
      const musicSeconds = 1 + random() * 19;
      const totalFrames = 1 + Math.floor(random() * 9000);
      const loop = planMusicLoop({musicSeconds, totalFrames, fps});
      const musicFrames = Math.max(1, Math.round(musicSeconds * fps));
      const last = loop.copies[loop.copies.length - 1];

      assert.ok(loop.copies.length <= Math.ceil(totalFrames / Math.ceil(musicFrames / 2)));
      assert.equal(last.fromFrame + last.durationInFrames, totalFrames);

      loop.copies.forEach((copy, index) => {
        assert.ok(copy.durationInFrames >= 1);
        assert.ok(copy.fromFrame < totalFrames);

        if (index > 0) {
          const previous = loop.copies[index - 1];

          assert.ok(copy.fromFrame - previous.fromFrame >= 1);
          assert.ok(copy.fromFrame <= previous.fromFrame + previous.durationInFrames);
        }
      });
    }
  });
});

describe("crossfadeFactorAt", () => {
  const loop = planMusicLoop({musicSeconds: 10, totalFrames: 600, fps: 30});

  it("is 1 away from the overlaps", () => {
    for (const frame of [0, 100, 290]) {
      assert.equal(crossfadeFactorAt(loop, 0, frame), 1);
    }

    assert.equal(crossfadeFactorAt(loop, 1, 300), 1);
    assert.equal(crossfadeFactorAt(loop, 1, 581), 1);
    assert.equal(crossfadeFactorAt(loop, 2, 599), 1);
  });

  it("crosses equal-power over the 9 overlap frames", () => {
    let previousOut = 2;
    let previousIn = -1;

    for (let frame = 291; frame <= 299; frame += 1) {
      const u = (frame - 291 + 0.5) / 9;
      const out = crossfadeFactorAt(loop, 0, frame);
      const incoming = crossfadeFactorAt(loop, 1, frame);

      close(out, Math.cos((Math.PI / 2) * u), `out ${frame}`);
      close(incoming, Math.sin((Math.PI / 2) * u), `in ${frame}`);
      close(out * out + incoming * incoming, 1, `power ${frame}`);
      assert.ok(out < previousOut && incoming > previousIn);
      previousOut = out;
      previousIn = incoming;
    }

    close(crossfadeFactorAt(loop, 0, 295), Math.SQRT1_2);
    close(crossfadeFactorAt(loop, 1, 295), Math.SQRT1_2);
  });

  it("crosses the second seam the same way", () => {
    close(crossfadeFactorAt(loop, 1, 586), Math.SQRT1_2);
    close(crossfadeFactorAt(loop, 2, 586), Math.SQRT1_2);
  });

  it("abuts copies without any factor when the crossfade is 0", () => {
    const abutting = planMusicLoop({
      musicSeconds: 1,
      totalFrames: 100,
      fps: 30,
      crossfadeSeconds: 0,
    });

    assert.deepEqual(
      abutting.copies.map((copy) => copy.fromFrame),
      [0, 30, 60, 90],
    );
    assert.equal(crossfadeFactorAt(abutting, 0, 29), 1);
    assert.equal(crossfadeFactorAt(abutting, 1, 30), 1);
  });
});

describe("resolveFades and fadeFactorAt", () => {
  it("scales both fades to fit a shorter Story", () => {
    const fades = resolveFades({
      fadeInSeconds: 3,
      fadeOutSeconds: 3,
      totalFrames: 120,
      fps: 30,
    });

    assert.equal(fades.scaled, true);
    close(fades.fadeInSeconds, 2);
    close(fades.fadeOutSeconds, 2);
  });

  it("keeps fades that exactly fit or have room", () => {
    assert.deepEqual(
      resolveFades({fadeInSeconds: 2, fadeOutSeconds: 2, totalFrames: 120, fps: 30}),
      {fadeInSeconds: 2, fadeOutSeconds: 2, scaled: false},
    );
    assert.deepEqual(
      resolveFades({fadeInSeconds: 0, fadeOutSeconds: 0, totalFrames: 1, fps: 30}),
      {fadeInSeconds: 0, fadeOutSeconds: 0, scaled: false},
    );
  });

  it("does not report float-rounding sums that fit exactly as scaled", () => {
    // 1.1 + 2.2 = 3.3000000000000003 s and 0.1 + 0.2 = 0.30000000000000004 s
    // are both exactly the Story length in frames.
    assert.deepEqual(
      resolveFades({fadeInSeconds: 1.1, fadeOutSeconds: 2.2, totalFrames: 99, fps: 30}),
      {fadeInSeconds: 1.1, fadeOutSeconds: 2.2, scaled: false},
    );
    assert.deepEqual(
      resolveFades({fadeInSeconds: 0.1, fadeOutSeconds: 0.2, totalFrames: 9, fps: 30}),
      {fadeInSeconds: 0.1, fadeOutSeconds: 0.2, scaled: false},
    );
  });

  it("still scales fades that are one frame too long", () => {
    const fades = resolveFades({
      fadeInSeconds: 1.1,
      fadeOutSeconds: 2.2,
      totalFrames: 98,
      fps: 30,
    });

    assert.equal(fades.scaled, true);
    close(fades.fadeInSeconds + fades.fadeOutSeconds, 98 / 30);
  });

  it("ramps linearly from 0 at frame 0 and down to 0 at the Story end", () => {
    const at = (frame) =>
      fadeFactorAt({
        frame,
        totalFrames: 120,
        fps: 30,
        fadeInSeconds: 1,
        fadeOutSeconds: 1,
      });

    close(at(0), 0);
    close(at(15), 0.5);
    close(at(30), 1);
    close(at(60), 1);
    close(at(90), 1);
    close(at(105), 0.5);
    close(at(119), 1 / 30);
    close(at(120), 0);
  });

  it("is 1 everywhere without fades", () => {
    for (const frame of [0, 1, 60, 119]) {
      assert.equal(
        fadeFactorAt({
          frame,
          totalFrames: 120,
          fps: 30,
          fadeInSeconds: 0,
          fadeOutSeconds: 0,
        }),
        1,
      );
    }
  });
});
