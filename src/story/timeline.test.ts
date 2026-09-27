import {describe, expect, it} from "vitest";
import {compileTimeline} from "./timeline";
import type {Story, StoryScene} from "./types";

const makeScene = (
  overrides: Partial<StoryScene> = {},
): StoryScene => ({
  type: "intro",
  pose: "formal",
  background: "office",
  text: "Test scene",
  duration: 1,
  ...overrides,
});

const makeStory = (scenes: StoryScene[]): Story => ({
  title: "Test story",
  scenes,
});

describe("compileTimeline", () => {
  it("compiles a single scene", () => {
    const timeline = compileTimeline(
      makeStory([makeScene({duration: 2})]),
      30,
    );

    expect(timeline.scenes).toHaveLength(1);
    expect(timeline.scenes[0]).toMatchObject({
      from: 0,
      durationInFrames: 60,
    });
    expect(timeline.durationInFrames).toBe(60);
  });

  it("calculates cumulative start frames for multiple scenes", () => {
    const timeline = compileTimeline(
      makeStory([
        makeScene({duration: 3}),
        makeScene({duration: 2}),
        makeScene({duration: 4}),
      ]),
      30,
    );

    expect(timeline.scenes.map(({from}) => from)).toEqual([0, 90, 150]);
    expect(
      timeline.scenes.map(({durationInFrames}) => durationInFrames),
    ).toEqual([90, 60, 120]);
    expect(timeline.durationInFrames).toBe(270);
  });

  it("rounds fractional frame durations", () => {
    const timeline = compileTimeline(
      makeStory([makeScene({duration: 1.25})]),
      30,
    );

    expect(timeline.scenes[0].durationInFrames).toBe(38);
    expect(timeline.durationInFrames).toBe(38);
  });

  it("moves subsequent scenes when a duration changes", () => {
    const original = compileTimeline(
      makeStory([
        makeScene({duration: 1}),
        makeScene({duration: 1}),
      ]),
      30,
    );

    const changed = compileTimeline(
      makeStory([
        makeScene({duration: 2}),
        makeScene({duration: 1}),
      ]),
      30,
    );

    expect(original.scenes[1].from).toBe(30);
    expect(changed.scenes[1].from).toBe(60);
    expect(changed.durationInFrames).toBe(90);
  });

  it("preserves story scene order", () => {
    const timeline = compileTimeline(
      makeStory([
        makeScene({type: "dialogue", text: "First"}),
        makeScene({type: "punchline", text: "Second"}),
      ]),
      30,
    );

    expect(timeline.scenes.map(({text}) => text)).toEqual([
      "First",
      "Second",
    ]);
  });
});
