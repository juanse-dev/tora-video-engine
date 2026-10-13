import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {getStoryMetadata} from "../src/story/metadata.ts";
import {compileTimeline, minimumStoryFrames} from "../src/story/timeline.ts";

const makeScene = (overrides = {}) => ({
  type: "intro",
  pose: "formal",
  background: "office",
  text: "Test scene",
  duration: 1,
  ...overrides,
});

const makeStory = (scenes) => ({
  title: "Test story",
  scenes,
});

describe("compileTimeline", () => {
  it("compiles a single scene", () => {
    const timeline = compileTimeline(
      makeStory([makeScene({duration: 2})]),
      30,
      {},
    );

    assert.equal(timeline.scenes.length, 1);
    assert.equal(timeline.scenes[0].from, 0);
    assert.equal(timeline.scenes[0].durationInFrames, 60);
    assert.equal(timeline.durationInFrames, 60);
  });

  it("calculates cumulative start frames for multiple scenes", () => {
    const timeline = compileTimeline(
      makeStory([
        makeScene({duration: 3}),
        makeScene({duration: 2}),
        makeScene({duration: 4}),
      ]),
      30,
      {},
    );

    assert.deepEqual(
      timeline.scenes.map(({from}) => from),
      [0, 90, 150],
    );
    assert.deepEqual(
      timeline.scenes.map(({durationInFrames}) => durationInFrames),
      [90, 60, 120],
    );
    assert.equal(timeline.durationInFrames, 270);
  });

  it("rounds fractional frame durations", () => {
    const timeline = compileTimeline(
      makeStory([makeScene({duration: 1.25})]),
      30,
      {},
    );

    assert.equal(timeline.scenes[0].durationInFrames, 38);
    assert.equal(timeline.durationInFrames, 38);
  });

  it("rejects scenes that round down to zero frames", () => {
    assert.throws(
      () =>
        compileTimeline(
          makeStory([makeScene({duration: 0.001, text: "Too short"})]),
          30,
          {},
        ),
      /must compile to a finite safe frame count of at least 1/,
    );
  });

  it("rejects scenes whose frame count overflows", () => {
    assert.throws(
      () =>
        compileTimeline(
          makeStory([makeScene({duration: 1e308, text: "Too long"})]),
          30,
          {},
        ),
      /must compile to a finite safe frame count of at least 1/,
    );
  });

  it("rejects stories whose cumulative frame count overflows", () => {
    assert.throws(
      () =>
        compileTimeline(
          makeStory([
            makeScene({duration: 300239975158033, text: "Almost max"}),
            makeScene({duration: 0.03, text: "Last safe frame"}),
            makeScene({duration: 0.03, text: "Overflow"}),
          ]),
          30,
          {},
        ),
      /cumulative timeline to exceed the safe integer frame range/,
    );
  });

  it("moves subsequent scenes when a duration changes", () => {
    const original = compileTimeline(
      makeStory([
        makeScene({duration: 1}),
        makeScene({duration: 1}),
      ]),
      30,
      {},
    );

    const changed = compileTimeline(
      makeStory([
        makeScene({duration: 2}),
        makeScene({duration: 1}),
      ]),
      30,
      {},
    );

    assert.equal(original.scenes[1].from, 30);
    assert.equal(changed.scenes[1].from, 60);
    assert.equal(changed.durationInFrames, 90);
  });

  it("derives composition metadata from the effective story", () => {
    const shortStory = makeStory([makeScene({duration: 1})]);
    const longStory = makeStory([
      makeScene({duration: 3}),
      makeScene({duration: 2}),
    ]);

    assert.equal(getStoryMetadata(shortStory, 30, {}).durationInFrames, 30);
    assert.equal(getStoryMetadata(longStory, 30, {}).durationInFrames, 150);
  });

  it("preserves story scene order", () => {
    const timeline = compileTimeline(
      makeStory([
        makeScene({type: "dialogue", text: "First"}),
        makeScene({type: "punchline", text: "Second"}),
      ]),
      30,
      {},
    );

    assert.deepEqual(
      timeline.scenes.map(({text}) => text),
      ["First", "Second"],
    );
  });
});

const voice = `local:audio:sha256:${"c".repeat(64)}`;

describe("duration: auto", () => {
  const story = makeStory([
    makeScene({duration: 1}),
    makeScene({duration: "auto", voice: {src: voice}}),
    makeScene({duration: 2}),
  ]);

  it("uses the voice duration plus padding, rounded up", () => {
    const t = compileTimeline(story, 30, {[voice]: 2.2});
    assert.deepEqual(t.scenes.map((s) => [s.from, s.durationInFrames, s.durationSource]),
      [[0, 30, "fixed"], [30, 81, "voice"], [111, 60, "fixed"]]);
    assert.equal(t.durationInFrames, 171);
  });

  it("falls back to 3 s when the voice duration is unknown", () => {
    const t = compileTimeline(story, 30, {});
    assert.deepEqual(t.scenes[1].durationInFrames, 90);
    assert.equal(t.scenes[1].durationSource, "fallback");
  });

  it("counts auto scenes at their lower bound for the acceptance policy", () => {
    assert.equal(minimumStoryFrames(story, 30), 30 + 16 + 60);
  });
});
