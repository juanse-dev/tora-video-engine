import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  SFX,
  VOICE,
  buildPlan,
  makeStory,
  scene,
  shape,
  tracksOf,
} from "./helpers/audioPlanFixtures.mjs";

describe("compileAudioPlan: no audio and bounds", () => {
  it("returns the empty plan for a Story without audio", () => {
    const plan = buildPlan(makeStory([scene(), scene()]));

    assert.deepEqual(plan, {
      tracks: [],
      issues: [],
      maxSimultaneousGain: 0,
      musicEnvelopeAt: null,
    });
  });

  it("returns no tracks and one issue for a Story longer than 3,600 s", () => {
    const longStory = makeStory([
      scene({duration: 3601, sfx: {src: SFX}, voice: {src: VOICE}}),
    ]);
    const plan = buildPlan(longStory);

    assert.deepEqual(plan, {
      tracks: [],
      issues: [{kind: "story-too-long-for-audio"}],
      maxSimultaneousGain: 0,
      musicEnvelopeAt: null,
    });

    const limitStory = makeStory([scene({duration: 3600, sfx: {src: SFX}})]);

    assert.deepEqual(shape(buildPlan(limitStory)), [["sfx-0", 0, 12]]);
  });
});

describe("compileAudioPlan: sfx", () => {
  it("lets an sfx cross into the next scene and truncates one past the Story end", () => {
    const plan = buildPlan(
      makeStory([
        scene({duration: 0.2, sfx: {src: SFX}}),
        scene({duration: 3}),
        scene({duration: 0.2, sfx: {src: SFX}}),
      ]),
    );

    // Story = 6 + 90 + 6 = 102 frames; the 0.4 s sfx is 12 frames.
    assert.deepEqual(shape(plan), [
      ["sfx-0", 0, 12],
      ["sfx-2", 96, 6],
    ]);
    assert.deepEqual(plan.issues, []);
  });

  it("plays at the clip volume, default 1, constant over the track", () => {
    const plan = buildPlan(
      makeStory([
        scene({sfx: {src: SFX}}),
        scene({sfx: {src: SFX, volume: 0.5}}),
      ]),
    );
    const [first, second] = plan.tracks;

    assert.equal(first.gainAt(0), 1);
    assert.equal(first.gainAt(11), 1);
    assert.equal(second.gainAt(90), 0.5);
    assert.equal(second.gainAt(101), 0.5);
  });
});

describe("compileAudioPlan: voice", () => {
  it("cuts a voice longer than a fixed scene and reports the cut in seconds", () => {
    const plan = buildPlan(
      makeStory([scene({duration: 1, voice: {src: VOICE, volume: 0.5}})]),
    );

    // 2.2 s = 66 frames in a 30-frame scene: 36 frames = 1.2 s are cut.
    assert.deepEqual(shape(plan), [["voice-0", 0, 30]]);
    assert.deepEqual(plan.issues, [
      {kind: "voice-cut", sceneIndex: 0, seconds: 1.2},
    ]);
    assert.equal(plan.tracks[0].gainAt(0), 0.5);
  });

  it("reports no cut for an auto scene, an exact fit or a longer scene", () => {
    const auto = buildPlan(
      makeStory([scene({duration: "auto", voice: {src: VOICE}})]),
    );

    // auto = ceil((2.2 + 0.5) * 30) = 81 frames; the voice is 66.
    assert.deepEqual(shape(auto), [["voice-0", 0, 66]]);
    assert.deepEqual(auto.issues, []);

    const exact = buildPlan(
      makeStory([scene({duration: 2.2, voice: {src: VOICE}})]),
    );

    assert.deepEqual(shape(exact), [["voice-0", 0, 66]]);
    assert.deepEqual(exact.issues, []);

    const longer = buildPlan(
      makeStory([scene({duration: 4, voice: {src: VOICE}})]),
    );

    assert.deepEqual(shape(longer), [["voice-0", 0, 66]]);
    assert.deepEqual(longer.issues, []);
  });

  it("starts a voice at its scene start", () => {
    const plan = buildPlan(
      makeStory([scene({duration: 3}), scene({duration: 3, voice: {src: VOICE}})]),
    );

    assert.deepEqual(shape(plan), [["voice-1", 90, 66]]);
  });
});

describe("compileAudioPlan: sources", () => {
  const story = makeStory([
    scene({sfx: {src: SFX}}),
    scene({voice: {src: VOICE}}),
  ]);

  it("emits nothing and records missing-audio for a missing source", () => {
    const plan = buildPlan(story, {
      sourceState: (ref) => (ref === SFX ? "missing" : "ready"),
    });

    assert.deepEqual(shape(plan), [["voice-1", 90, 66]]);
    assert.deepEqual(plan.issues, [
      {kind: "missing-audio", ref: SFX, role: "sfx", sceneIndex: 0},
    ]);
  });

  it("emits nothing and records pending-audio for a pending source", () => {
    const plan = buildPlan(story, {
      sourceState: (ref) => (ref === VOICE ? "pending" : "ready"),
    });

    assert.deepEqual(shape(plan), [["sfx-0", 0, 12]]);
    assert.deepEqual(plan.issues, [
      {kind: "pending-audio", ref: VOICE, role: "voice", sceneIndex: 1},
    ]);
  });

  it("records pending-audio, never missing-audio, for a ready source without a duration", () => {
    const plan = buildPlan(story, {durations: {[VOICE]: 2.2}});

    assert.deepEqual(shape(plan), [["voice-1", 90, 66]]);
    assert.deepEqual(plan.issues, [
      {kind: "pending-audio", ref: SFX, role: "sfx", sceneIndex: 0},
    ]);
  });

  it("treats a missing source as missing even when no duration is known", () => {
    const plan = buildPlan(story, {
      durations: {},
      sourceState: () => "missing",
    });

    assert.deepEqual(plan.tracks, []);
    assert.deepEqual(
      plan.issues.map((issue) => issue.kind),
      ["missing-audio", "missing-audio"],
    );
  });

  for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
    it(`treats a duration of ${bad} like an unmeasured source`, () => {
      const plan = buildPlan(story, {durations: {[SFX]: bad, [VOICE]: bad}});

      assert.deepEqual(plan.tracks, []);
      assert.deepEqual(plan.issues, [
        {kind: "pending-audio", ref: SFX, role: "sfx", sceneIndex: 0},
        {kind: "pending-audio", ref: VOICE, role: "voice", sceneIndex: 1},
      ]);
      assert.equal(plan.maxSimultaneousGain, 0);
    });
  }

  it("asks sourceState for the refs the Story uses and nothing else", () => {
    const asked = new Set();

    buildPlan(story, {
      sourceState: (ref) => {
        asked.add(ref);

        return "ready";
      },
    });

    assert.deepEqual([...asked].sort(), [SFX, VOICE].sort());
  });
});

describe("compileAudioPlan: lengths and keys", () => {
  it("gives sub-frame sources exactly one frame in fixed and auto scenes", () => {
    const tiny = {[SFX]: 0.005, [VOICE]: 0.005};
    const plan = buildPlan(
      makeStory([
        scene({duration: 1, sfx: {src: SFX}, voice: {src: VOICE}}),
        scene({duration: "auto", voice: {src: VOICE}}),
      ]),
      {durations: tiny},
    );

    // The auto scene lasts ceil((0.005 + 0.5) * 30) = 16 frames.
    assert.deepEqual(shape(plan), [
      ["sfx-0", 0, 1],
      ["voice-0", 0, 1],
      ["voice-1", 30, 1],
    ]);
    assert.deepEqual(plan.issues, []);
  });

  it("never emits a track shorter than one frame for random durations in (0, 0.05] s", () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;

      return seed / 4294967296;
    };

    for (let round = 0; round < 200; round += 1) {
      const sfx = 0.0001 + random() * 0.0499;
      const voice = 0.0001 + random() * 0.0499;
      const plan = buildPlan(
        makeStory([
          scene({duration: 0.04, sfx: {src: SFX}, voice: {src: VOICE}}),
          scene({duration: "auto", voice: {src: VOICE}}),
          scene({duration: 1, sfx: {src: SFX}}),
        ]),
        {durations: {[SFX]: sfx, [VOICE]: voice}},
      );

      assert.equal(plan.tracks.length, 4);

      for (const track of plan.tracks) {
        assert.ok(track.durationInFrames >= 1, `${track.key} at ${sfx}/${voice}`);
        assert.ok(Number.isInteger(track.durationInFrames));
      }
    }
  });

  it("keeps track keys stable across calls", () => {
    const story = makeStory([
      scene(),
      scene(),
      scene(),
      scene({sfx: {src: SFX}, voice: {src: VOICE}}),
    ]);
    const keys = () => buildPlan(story).tracks.map((track) => track.key);

    assert.deepEqual(keys(), ["sfx-3", "voice-3"]);
    assert.deepEqual(keys(), keys());
  });

  it("derives every length from the composition FPS", () => {
    const plan = buildPlan(
      makeStory([scene({duration: 1, sfx: {src: SFX}, voice: {src: VOICE}})]),
      {fps: 60},
    );

    // 0.4 s = 24 frames; 2.2 s = 132 frames cut to the 60-frame scene: 72 frames = 1.2 s.
    assert.deepEqual(shape(plan), [
      ["sfx-0", 0, 24],
      ["voice-0", 0, 60],
    ]);
    assert.deepEqual(plan.issues, [
      {kind: "voice-cut", sceneIndex: 0, seconds: 1.2},
    ]);
  });

  it("plans thousands of scenes with an sfx each", () => {
    const scenes = Array.from({length: 3000}, () =>
      scene({duration: 1 / 30, sfx: {src: SFX}}),
    );
    const plan = buildPlan(makeStory(scenes));

    assert.equal(plan.tracks.length, 3000);
    assert.deepEqual(
      [plan.tracks[2999].fromFrame, plan.tracks[2999].durationInFrames],
      [2999, 1],
    );
    // Twelve 12-frame effects overlap on every frame from 11 on.
    assert.equal(plan.maxSimultaneousGain, 12);
  });
});

describe("compileAudioPlan: clipping hint without music", () => {
  it("sums the gains of the tracks mounted together", () => {
    const plan = buildPlan(
      makeStory([
        scene({sfx: {src: SFX}, voice: {src: VOICE, volume: 0.5}}),
      ]),
    );

    assert.equal(plan.maxSimultaneousGain, 1.5);
  });

  it("takes the largest frame when tracks do not overlap", () => {
    const plan = buildPlan(
      makeStory([
        scene({sfx: {src: SFX}}),
        scene({voice: {src: VOICE, volume: 0.5}}),
      ]),
    );

    assert.equal(plan.maxSimultaneousGain, 1);
    assert.equal(tracksOf(plan, "sfx").length, 1);
  });
});
