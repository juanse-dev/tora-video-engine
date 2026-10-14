import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  MUSIC,
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

const close = (actual, expected, label = "") =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${label} expected ${expected}, got ${actual}`,
  );
// Five 4 s scenes: a 600-frame Story, longer than the 10 s (300-frame) music.
const loopStory = (music = {src: MUSIC}) =>
  makeStory(Array.from({length: 5}, () => scene({duration: 4})), music);

describe("compileAudioPlan: music loop", () => {
  it("overlaps copies at k * (300 - 9) frames and truncates the last one", () => {
    const plan = buildPlan(loopStory());

    assert.deepEqual(shape(plan), [
      ["music-0", 0, 300],
      ["music-1", 291, 300],
      ["music-2", 582, 18],
    ]);
    assert.deepEqual(plan.issues, []);
    assert.deepEqual(
      plan.tracks.map((track) => [track.role, track.ref, track.sceneIndex]),
      [
        ["music", MUSIC, null],
        ["music", MUSIC, null],
        ["music", MUSIC, null],
      ],
    );
  });

  it("crosses equal-power: out^2 + in^2 = 1 at every overlap frame, both monotonic", () => {
    const [first, second] = buildPlan(loopStory()).tracks;
    let previousOut = 2;
    let previousIn = -1;

    for (let frame = 291; frame <= 299; frame += 1) {
      const out = first.gainAt(frame);
      const incoming = second.gainAt(frame);

      close(out * out + incoming * incoming, 1, `frame ${frame}`);
      assert.ok(out < previousOut, `out falls at ${frame}`);
      assert.ok(incoming > previousIn, `in rises at ${frame}`);
      previousOut = out;
      previousIn = incoming;
    }

    close(first.gainAt(290), 1);
    close(second.gainAt(300), 1);
  });

  it("documents D-4: two tones sum to sqrt(2)*cos(phi/2) at the centre, noise keeps its power", () => {
    const [first, second] = buildPlan(loopStory()).tracks;
    const out = first.gainAt(295);
    const incoming = second.gainAt(295);
    const amplitude = (a, b, phi) =>
      Math.sqrt(a * a + b * b + 2 * a * b * Math.cos(phi));
    const radians = (degrees) => (degrees * Math.PI) / 180;

    // Equal power: 1.41 in phase, 0.71 at 120 degrees, 0 in antiphase.
    close(amplitude(out, incoming, 0), Math.SQRT2);
    close(amplitude(out, incoming, radians(120)), Math.SQRT1_2);
    close(amplitude(out, incoming, radians(180)), 0);
    // The linear law (u, 1 - u) would give cos(phi/2): 1, 0.5, 0.
    close(amplitude(0.5, 0.5, 0), 1);
    close(amplitude(0.5, 0.5, radians(120)), 0.5);
    close(amplitude(0.5, 0.5, radians(180)), 0);

    // Two independent seeded noise signals keep their power across the overlap.
    let seed = 20260101;
    const uniform = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;

      return seed / 4294967296;
    };
    const gaussian = () =>
      Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
    const samplesPerFrame = 1600;
    let power = 0;
    let count = 0;

    for (let frame = 291; frame <= 299; frame += 1) {
      for (let sample = 0; sample < samplesPerFrame; sample += 1) {
        const mixed =
          first.gainAt(frame) * gaussian() + second.gainAt(frame) * gaussian();

        power += mixed * mixed;
        count += 1;
      }
    }

    const rms = Math.sqrt(power / count);

    assert.ok(rms > 0.9 && rms < 1.1, `RMS ${rms}`);
  });

  it("plays one copy of the Story length when the music is longer", () => {
    const longer = buildPlan(
      makeStory([scene({duration: 5})], {src: MUSIC}),
    );

    assert.deepEqual(shape(longer), [["music-0", 0, 150]]);

    const exact = buildPlan(
      makeStory([scene({duration: 10})], {src: MUSIC}),
    );

    assert.deepEqual(shape(exact), [["music-0", 0, 300]]);
  });

  it("plays the 0.12 s pop once and reports music-too-short-to-loop", () => {
    const plan = buildPlan(makeStory([scene()], {src: "pop"}), {
      durations: {pop: 0.12},
    });

    assert.deepEqual(shape(plan), [["music-0", 0, 4]]);
    assert.deepEqual(plan.issues, [{kind: "music-too-short-to-loop"}]);
  });

  it("loops 1.0 s music with a 9-frame crossfade and a 21-frame stride", () => {
    const plan = buildPlan(
      makeStory([scene({duration: 100 / 30})], {src: MUSIC}),
      {durations: {[MUSIC]: 1}},
    );

    assert.deepEqual(shape(plan), [
      ["music-0", 0, 30],
      ["music-1", 21, 30],
      ["music-2", 42, 30],
      ["music-3", 63, 30],
      ["music-4", 84, 16],
    ]);

    const half = buildPlan(
      makeStory([scene({duration: 100 / 30})], {src: MUSIC}),
      {durations: {[MUSIC]: 0.5}},
    );

    assert.deepEqual(shape(half), [["music-0", 0, 15]]);
    assert.deepEqual(half.issues, [{kind: "music-too-short-to-loop"}]);
  });

  it("derives the overlap from the FPS", () => {
    const plan = buildPlan(
      makeStory([scene({duration: 20})], {src: MUSIC}),
      {fps: 60},
    );

    // 10 s = 600 frames, X = round(0.3 * 60) = 18, stride 582, Story = 1200 frames.
    assert.deepEqual(shape(plan), [
      ["music-0", 0, 600],
      ["music-1", 582, 600],
      ["music-2", 1164, 36],
    ]);
  });

  it("bounds the copies of a 3,600 s Story at 5,143 and refuses a longer one", () => {
    const hour = makeStory([scene({duration: 3600})], {src: MUSIC});
    const plan = buildPlan(hour, {durations: {[MUSIC]: 1}});

    assert.equal(plan.tracks.length, 5143);
    assert.deepEqual(
      [plan.tracks[5142].fromFrame, plan.tracks[5142].durationInFrames],
      [107982, 18],
    );
    close(plan.maxSimultaneousGain, Math.SQRT2);

    const tooLong = buildPlan(makeStory([scene({duration: 3601})], {src: MUSIC}), {
      durations: {[MUSIC]: 1},
    });

    assert.deepEqual(tooLong.tracks, []);
    assert.deepEqual(tooLong.issues, [{kind: "story-too-long-for-audio"}]);
  });

  it("emits nothing for a missing or pending music source and keeps the other tracks", () => {
    const story = makeStory([scene({sfx: {src: SFX}})], {src: MUSIC});
    const missing = buildPlan(story, {
      sourceState: (ref) => (ref === MUSIC ? "missing" : "ready"),
    });

    assert.deepEqual(shape(missing), [["sfx-0", 0, 12]]);
    assert.deepEqual(missing.issues, [
      {kind: "missing-audio", ref: MUSIC, role: "music", sceneIndex: null},
    ]);
    assert.equal(missing.musicEnvelopeAt, null);

    const pending = buildPlan(story, {
      sourceState: (ref) => (ref === MUSIC ? "pending" : "ready"),
    });

    assert.deepEqual(pending.issues, [
      {kind: "pending-audio", ref: MUSIC, role: "music", sceneIndex: null},
    ]);

    const unmeasured = buildPlan(story, {durations: {[SFX]: 0.4}});

    assert.deepEqual(unmeasured.issues, [
      {kind: "pending-audio", ref: MUSIC, role: "music", sceneIndex: null},
    ]);
  });
});

describe("compileAudioPlan: music envelope", () => {
  // A 4 s Story: 120 frames, shorter than the music, so one copy.
  const fourSeconds = (music) => makeStory([scene({duration: 4})], music);

  it("ramps the fades linearly with values at their endpoints and midpoints", () => {
    const plan = buildPlan(
      fourSeconds({src: MUSIC, fadeIn: 1, fadeOut: 1}),
    );
    const envelope = plan.musicEnvelopeAt;

    assert.deepEqual(plan.issues, []);
    close(envelope(0), 0);
    close(envelope(15), 0.5);
    close(envelope(30), 1);
    close(envelope(60), 1);
    close(envelope(105), 0.5);
    close(envelope(119), 1 / 30);
    close(envelope(120), 0);
    close(plan.tracks[0].gainAt(15), 0.5);
  });

  it("scales fades that do not fit and records fades-scaled", () => {
    const plan = buildPlan(fourSeconds({src: MUSIC, fadeIn: 3, fadeOut: 3}));
    const envelope = plan.musicEnvelopeAt;

    assert.deepEqual(plan.issues, [{kind: "fades-scaled"}]);
    close(envelope(0), 0);
    close(envelope(30), 0.5);
    close(envelope(60), 1);
    close(envelope(90), 0.5);

    const exact = buildPlan(fourSeconds({src: MUSIC, fadeIn: 2, fadeOut: 2}));

    assert.deepEqual(exact.issues, []);
  });

  it("applies the music volume, default 1", () => {
    const full = buildPlan(fourSeconds({src: MUSIC}));
    const quiet = buildPlan(fourSeconds({src: MUSIC, volume: 0.6}));

    assert.equal(full.musicEnvelopeAt(60), 1);
    close(quiet.musicEnvelopeAt(60), 0.6);
  });

  it("has no envelope without music", () => {
    assert.equal(
      buildPlan(makeStory([scene({sfx: {src: SFX}})])).musicEnvelopeAt,
      null,
    );
  });
});

describe("compileAudioPlan: ducking", () => {
  // `lengths[i]` is the length in frames of scene i; every scene after the
  // first carries an sfx (12 frames at 30 FPS).
  const withSfx = (...lengths) =>
    makeStory(
      lengths.map((length, index) =>
        scene({
          duration: length / 30,
          ...(index === 0 ? {} : {sfx: {src: SFX}}),
        }),
      ),
      {src: MUSIC},
    );

  it("ramps to the default 0.35 over 5 frames before an effect and back after it", () => {
    // Scene 1 starts at frame 90 and its sfx sounds on [90, 102).
    const envelope = buildPlan(withSfx(90, 90, 90)).musicEnvelopeAt;

    close(envelope(84), 1);
    close(envelope(85), 1);
    close(envelope(86), 0.87);
    close(envelope(89), 0.48);
    close(envelope(90), 0.35);
    close(envelope(101), 0.35);
    close(envelope(102), 0.35);
    close(envelope(103), 0.48);
    close(envelope(106), 0.87);
    close(envelope(107), 1);
  });

  it("merges effects 0.2 s apart but not 0.5 s apart", () => {
    // Windows [90, 102) and [108, 120): a 6-frame gap merges into one.
    const merged = buildPlan(withSfx(90, 18, 90)).musicEnvelopeAt;

    close(merged(105), 0.35);
    close(merged(107), 0.35);

    // Windows [90, 102) and [117, 129): a 15-frame gap stays two windows.
    const apart = buildPlan(withSfx(90, 27, 90)).musicEnvelopeAt;

    close(apart(105), 0.74);
    close(apart(109), 1);
    close(apart(115), 0.61);
  });

  it("merges a gap of 8 frames and keeps a gap of 9", () => {
    // Scene 1 is 20 frames long: windows [90, 102) and [110, 122), gap 8.
    const eight = buildPlan(withSfx(90, 20, 90)).musicEnvelopeAt;

    close(eight(106), 0.35);

    // Scene 1 is 21 frames long: windows [90, 102) and [111, 123), gap 9.
    const nine = buildPlan(withSfx(90, 21, 90)).musicEnvelopeAt;

    close(nine(106), 0.87);
  });

  it("ducks from the first frame when the effect starts the Story", () => {
    const plan = buildPlan(
      makeStory([scene({sfx: {src: SFX}}), scene()], {src: MUSIC}),
    );

    close(plan.musicEnvelopeAt(0), 0.35);
    close(plan.musicEnvelopeAt(12), 0.35);
    close(plan.musicEnvelopeAt(17), 1);
  });

  it("ducks under a voice for the whole voice", () => {
    const plan = buildPlan(
      makeStory([scene({voice: {src: VOICE}}), scene()], {src: MUSIC}),
    );

    close(plan.musicEnvelopeAt(0), 0.35);
    close(plan.musicEnvelopeAt(65), 0.35);
    close(plan.musicEnvelopeAt(66), 0.35);
    close(plan.musicEnvelopeAt(71), 1);
  });

  it("honours duck 1 (no ducking) and duck 0 (silence under effects)", () => {
    const story = (duck) =>
      makeStory([scene({duration: 3}), scene({sfx: {src: SFX}})], {
        src: MUSIC,
        duck,
      });

    for (const frame of [0, 89, 90, 95, 120]) {
      assert.equal(buildPlan(story(1)).musicEnvelopeAt(frame), 1);
    }

    close(buildPlan(story(0)).musicEnvelopeAt(95), 0);
    close(buildPlan(story(0.5)).musicEnvelopeAt(95), 0.5);
  });

  it("gives a 1-frame effect a 1-frame window with the usual ramps", () => {
    const plan = buildPlan(
      makeStory([scene({duration: 1}), scene({duration: 1, sfx: {src: SFX}})], {
        src: MUSIC,
      }),
      {durations: {[MUSIC]: 10, [SFX]: 0.005}},
    );
    const envelope = plan.musicEnvelopeAt;

    close(envelope(25), 1);
    close(envelope(29), 0.48);
    close(envelope(30), 0.35);
    close(envelope(31), 0.35);
    close(envelope(32), 0.48);
    close(envelope(36), 1);
  });

  it("ducks copies of looping music through the shared envelope", () => {
    const plan = buildPlan(
      makeStory(
        Array.from({length: 5}, (_, index) =>
          scene({duration: 4, ...(index === 1 ? {sfx: {src: SFX}} : {})}),
        ),
        {src: MUSIC},
      ),
    );

    // Scene 1 starts at frame 120: the first copy is ducked there.
    close(plan.tracks[0].gainAt(125), 0.35);
    close(plan.tracks[0].gainAt(200), 1);
  });
});

describe("compileAudioPlan: clipping hint with music", () => {
  it("is sqrt(2) for looping full-volume music and 1 when it does not loop", () => {
    close(buildPlan(loopStory()).maxSimultaneousGain, Math.SQRT2);
    close(
      buildPlan(makeStory([scene({duration: 10})], {src: MUSIC}))
        .maxSimultaneousGain,
      1,
    );
    close(
      buildPlan(makeStory([scene({duration: 4})], {src: MUSIC}))
        .maxSimultaneousGain,
      1,
    );
  });

  it("adds an overlapping effect, voice and ducked music", () => {
    const plan = buildPlan(
      makeStory(
        [
          scene({
            duration: 4,
            sfx: {src: SFX},
            voice: {src: VOICE, volume: 0.5},
          }),
        ],
        {src: MUSIC, volume: 0.8, duck: 0.5},
      ),
    );

    // Frames 0..11: sfx 1 + voice 0.5 + music 0.8 * 0.5 = 1.9.
    close(plan.maxSimultaneousGain, 1.9);
  });
});

describe("compileAudioPlan: keys with music", () => {
  it("names music copies music-0, music-1, ... and keeps every key stable", () => {
    const story = loopStory();
    const keys = () => buildPlan(story).tracks.map((track) => track.key);

    assert.deepEqual(keys(), ["music-0", "music-1", "music-2"]);
    assert.deepEqual(keys(), keys());
  });
});

describe("compileAudioPlan: silent Story bound (AINV-6)", () => {
  it("returns the empty plan, with no issue, for a silent Story longer than 3,600 s", () => {
    const plan = buildPlan(makeStory([scene({duration: 3601})]));

    assert.deepEqual(plan, {
      tracks: [],
      issues: [],
      maxSimultaneousGain: 0,
      musicEnvelopeAt: null,
    });
  });
});

describe("compileAudioPlan: ducking uses emitted tracks only", () => {
  // Scene 0 is 90 frames, scene 1 (with the sfx) starts at frame 90 and lasts
  // 90 frames, scene 2 is 90 frames: a 270-frame Story, shorter than the 300-frame music.
  const story = makeStory(
    [
      scene({duration: 3}),
      scene({duration: 3, sfx: {src: SFX}}),
      scene({duration: 3}),
    ],
    {src: MUSIC},
  );
  // Where an emitted sfx [90, 102) would duck the music: ramp 85..89, window, ramp 102..106.
  const duckedFrames = [86, 89, 90, 95, 101, 102, 103, 106];
  const cases = [
    {
      name: "missing",
      options: {sourceState: (ref) => (ref === SFX ? "missing" : "ready")},
      issue: {kind: "missing-audio", ref: SFX, role: "sfx", sceneIndex: 1},
    },
    {
      name: "pending",
      options: {sourceState: (ref) => (ref === SFX ? "pending" : "ready")},
      issue: {kind: "pending-audio", ref: SFX, role: "sfx", sceneIndex: 1},
    },
    {
      name: "ready but unmeasured",
      options: {durations: {[MUSIC]: 10}},
      issue: {kind: "pending-audio", ref: SFX, role: "sfx", sceneIndex: 1},
    },
  ];

  for (const {name, options, issue} of cases) {
    it(`does not duck the music for a ${name} sfx`, () => {
      const plan = buildPlan(story, options);

      assert.deepEqual(shape(plan), [["music-0", 0, 270]]);
      assert.deepEqual(plan.issues, [issue]);

      for (const frame of duckedFrames) {
        assert.equal(plan.musicEnvelopeAt(frame), 1, `frame ${frame}`);
      }

      assert.equal(plan.tracks[0].gainAt(95), 1);
    });
  }

  it("ducks once the same sfx is ready (control for the cases above)", () => {
    const plan = buildPlan(story);

    close(plan.musicEnvelopeAt(95), 0.35);
  });
});

describe("compileAudioPlan: ducking windows use the clamped track lengths", () => {
  it("ducks a voice cut by a fixed scene for the 30 scene frames, not the 66 voice frames", () => {
    // The 2.2 s voice (66 frames) is cut to the 30-frame scene: window [0, 30).
    const plan = buildPlan(
      makeStory(
        [scene({duration: 1, voice: {src: VOICE}}), scene({duration: 3})],
        {src: MUSIC},
      ),
    );
    const envelope = plan.musicEnvelopeAt;

    assert.deepEqual(shape(plan), [
      ["music-0", 0, 120],
      ["voice-0", 0, 30],
    ]);
    close(envelope(29), 0.35);
    // Trailing ramp 30..34 = 0.35 + 0.65 * (frame - 30) / 5.
    close(envelope(30), 0.35);
    close(envelope(34), 0.35 + (0.65 * 4) / 5);
    // Back to full volume at window end + R = 35 (a 66-frame window would still duck here).
    close(envelope(35), 1);
    close(envelope(36), 1);
  });

  it("ends the window of an sfx truncated at the Story end at that end", () => {
    // Scene 1 starts at 90 and lasts 6 frames: T = 96. The 12-frame sfx is cut to [90, 96).
    const plan = buildPlan(
      makeStory(
        [scene({duration: 3}), scene({duration: 0.2, sfx: {src: SFX}})],
        {src: MUSIC},
      ),
    );
    const envelope = plan.musicEnvelopeAt;

    assert.deepEqual(shape(plan), [
      ["music-0", 0, 96],
      ["sfx-1", 90, 6],
    ]);
    close(envelope(95), 0.35);
    close(envelope(96), 0.35);
    close(envelope(100), 0.35 + (0.65 * 4) / 5);
    // Window end 96 + R 5 = 101: full volume (a 102-frame window would still duck here).
    close(envelope(101), 1);
  });
});

describe("compileAudioPlan: ducking scales with the FPS", () => {
  // At 60 FPS: R = round(0.15 * 60) = 9, merge gap = round(0.3 * 60) = 18,
  // and the 0.4 s sfx lasts 24 frames. Scene 0 is 90 frames; scene 1 starts at
  // 90 with an sfx [90, 114); scene 2 starts at 90 + L and has an sfx too.
  const sixty = (sceneOneFrames) =>
    buildPlan(
      makeStory(
        [
          scene({duration: 90 / 60}),
          scene({duration: sceneOneFrames / 60, sfx: {src: SFX}}),
          scene({duration: 90 / 60, sfx: {src: SFX}}),
        ],
        {src: MUSIC},
      ),
      {fps: 60},
    );

  it("ramps over 9 frames", () => {
    const plan = sixty(42);
    const envelope = plan.musicEnvelopeAt;

    assert.deepEqual(
      plan.tracks.map((track) => [track.key, track.fromFrame, track.durationInFrames]),
      [
        ["music-0", 0, 222],
        ["sfx-1", 90, 24],
        ["sfx-2", 132, 24],
      ],
    );
    // Leading ramp 81..89 = 1 - 0.65 * (frame - 81) / 9.
    close(envelope(80), 1);
    close(envelope(81), 1);
    close(envelope(82), 1 - 0.65 / 9);
    close(envelope(89), 1 - (0.65 * 8) / 9);
    close(envelope(90), 0.35);
    close(envelope(113), 0.35);
    // Trailing ramp 114..122 = 0.35 + 0.65 * (frame - 114) / 9.
    close(envelope(114), 0.35);
    close(envelope(115), 0.35 + 0.65 / 9);
    close(envelope(120), 0.35 + (0.65 * 6) / 9);
  });

  it("merges windows 17 frames apart", () => {
    // Scene 1 = 41 frames: windows [90, 114) and [131, 155), gap 17 < 18.
    const plan = sixty(41);

    assert.deepEqual(
      plan.tracks.map((track) => [track.key, track.fromFrame]),
      [
        ["music-0", 0],
        ["sfx-1", 90],
        ["sfx-2", 131],
      ],
    );
    close(plan.musicEnvelopeAt(114), 0.35);
    close(plan.musicEnvelopeAt(120), 0.35);
    close(plan.musicEnvelopeAt(130), 0.35);
  });

  it("keeps windows 18 frames apart separate", () => {
    // Scene 1 = 42 frames: windows [90, 114) and [132, 156), gap 18, not < 18.
    const plan = sixty(42);

    // Trailing ramp of the first window: 120 is 6 frames after 114.
    close(plan.musicEnvelopeAt(120), 0.35 + (0.65 * 6) / 9);
    // The first ramp ends at 114 + 9 = 123, the second starts at 132 - 9 = 123.
    close(plan.musicEnvelopeAt(122), 0.35 + (0.65 * 8) / 9);
    close(plan.musicEnvelopeAt(123), 1);
  });
});

describe("compileAudioPlan: issue order across sources", () => {
  it("lists music-too-short-to-loop, fades-scaled, then the scene issues", () => {
    // The 3 s Story is 90 frames; fades 3 s + 3 s = 6 s exceed it and scale.
    const plan = buildPlan(
      makeStory([scene({duration: 3, sfx: {src: SFX}})], {
        src: "pop",
        fadeIn: 3,
        fadeOut: 3,
      }),
      {
        durations: {pop: 0.12, [SFX]: 0.4},
        sourceState: (ref) => (ref === SFX ? "pending" : "ready"),
      },
    );

    assert.deepEqual(shape(plan), [["music-0", 0, 4]]);
    assert.deepEqual(plan.issues, [
      {kind: "music-too-short-to-loop"},
      {kind: "fades-scaled"},
      {kind: "pending-audio", ref: SFX, role: "sfx", sceneIndex: 0},
    ]);
  });

  it("lists the music source issue before the scene issues", () => {
    const plan = buildPlan(
      makeStory([scene({sfx: {src: SFX}})], {src: MUSIC}),
      {sourceState: () => "pending"},
    );

    assert.deepEqual(plan.tracks, []);
    assert.deepEqual(plan.issues, [
      {kind: "pending-audio", ref: MUSIC, role: "music", sceneIndex: null},
      {kind: "pending-audio", ref: SFX, role: "sfx", sceneIndex: 0},
    ]);
  });

  it("records one missing-audio issue per use of the same missing ref", () => {
    const plan = buildPlan(
      makeStory([
        scene({sfx: {src: SFX}}),
        scene(),
        scene({sfx: {src: SFX}}),
      ]),
      {sourceState: () => "missing"},
    );

    assert.deepEqual(plan.tracks, []);
    assert.deepEqual(plan.issues, [
      {kind: "missing-audio", ref: SFX, role: "sfx", sceneIndex: 0},
      {kind: "missing-audio", ref: SFX, role: "sfx", sceneIndex: 2},
    ]);
  });
});
