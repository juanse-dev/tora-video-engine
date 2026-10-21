import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {compileAudioPlan} from "../src/audio/plan.ts";
import {audioSourceState, resolveAudioSrc} from "../src/audio/sources.ts";
import {storyAudioDurations} from "../src/audio/storyAudio.ts";
import {compileTimeline} from "../src/story/timeline.ts";
import {compileEditorAudioPlan} from "../src/web/audio/audioPlanView.ts";
import {
  bandOfRole,
  frameFromPointer,
  frameSpan,
  laneOfRole,
  playheadPercent,
  sampleEnvelope,
  sceneBlocks,
  sceneIndexAtFrame,
  seekTarget,
  timelineLabel,
  timelinePlaceholders,
  trackSpan,
} from "../src/web/audio/audioTimeline.ts";
import {
  drawEffectsLane,
  drawMusicLane,
} from "../src/web/audio/drawTimelineLane.ts";

const FPS = 30;
const MUSIC = `local:audio:sha256:${"a".repeat(64)}`;
const VOICE = `local:audio:sha256:${"b".repeat(64)}`;
const scene = (extra = {}) => ({
  type: "dialogue",
  pose: "formal",
  background: "office",
  text: "Hi",
  duration: 3,
  ...extra,
});
const url = (name) => ({kind: "url", url: `blob:http://localhost/${name}`});
const viewFor = (story, {local = {}, sources = {}} = {}) =>
  compileEditorAudioPlan({
    story,
    fps: FPS,
    audioDurations: storyAudioDurations(story, local),
    audioSources: sources,
  });
// Three 3 s scenes (270 frames): a ding at the start of scene 1, a 2.2 s voice in scene 2, 10 s of music with a 1 s fade in.
const fullStory = {
  title: "Timeline",
  music: {src: MUSIC, fadeIn: 1},
  scenes: [scene({sfx: {src: "ding"}}), scene({voice: {src: VOICE}}), scene()],
};
const fullSources = {ding: url("ding"), [MUSIC]: url("music"), [VOICE]: url("voice")};
const fullView = () => viewFor(fullStory, {local: {[MUSIC]: 10, [VOICE]: 2.2}, sources: fullSources});

/** A recording 2D context. */
const recorder = () => {
  const calls = [];

  return {
    calls,
    context: {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      clearRect: (...args) => calls.push(["clear", ...args]),
      fillRect: (...args) => calls.push(["fill", ...args]),
      beginPath: () => calls.push(["begin"]),
      moveTo: (...args) => calls.push(["move", ...args]),
      lineTo: (...args) => calls.push(["line", ...args]),
      stroke: () => calls.push(["stroke"]),
    },
  };
};
const fills = (calls) => calls.filter(([kind]) => kind === "fill");

describe("timeline layout", () => {
  it("frameSpan is the extent in percent of the Story, kept inside it", () => {
    assert.deepEqual(frameSpan(30, 60, 300), {leftPct: 10, widthPct: 20});
    assert.deepEqual(frameSpan(0, 300, 300), {leftPct: 0, widthPct: 100});
    assert.deepEqual(frameSpan(250, 100, 300), {leftPct: (250 / 300) * 100, widthPct: (50 / 300) * 100});
    assert.deepEqual(frameSpan(-20, 40, 300), {leftPct: 0, widthPct: (20 / 300) * 100});
    assert.deepEqual(frameSpan(400, 40, 300), {leftPct: 100, widthPct: 0});
    assert.deepEqual(frameSpan(0, 10, 0), {leftPct: 0, widthPct: 0});
  });

  it("scene blocks are proportional to durationInFrames and carry the scene number", () => {
    const timeline = compileTimeline(
      {title: "T", scenes: [scene({duration: 3}), scene({duration: 2}), scene({duration: 1})]},
      FPS,
      {},
    );
    const blocks = sceneBlocks(timeline);

    assert.deepEqual(blocks.map((block) => block.number), [1, 2, 3]);
    assert.deepEqual(blocks.map((block) => block.leftPct), [0, 50, (150 / 180) * 100]);
    assert.deepEqual(blocks.map((block) => block.widthPct), [50, (60 / 180) * 100, (30 / 180) * 100]);
    assert.equal(blocks.reduce((sum, block) => sum + block.widthPct, 0), 100);
  });

  it("a track's span follows its fromFrame and duration", () => {
    const view = fullView();
    const ding = view.plan.tracks.find((track) => track.key === "sfx-0");
    const voice = view.plan.tracks.find((track) => track.key === "voice-1");

    assert.deepEqual(trackSpan(ding, 270), {leftPct: 0, widthPct: (54 / 270) * 100});
    assert.deepEqual(trackSpan(voice, 270), {leftPct: (90 / 270) * 100, widthPct: (66 / 270) * 100});
  });

  it("the playhead is at frame / total, between 0 and 100", () => {
    assert.equal(playheadPercent(0, 300), 0);
    assert.equal(playheadPercent(150, 300), 50);
    assert.equal(playheadPercent(299, 300), (299 / 300) * 100);
    assert.equal(playheadPercent(-5, 300), 0);
    assert.equal(playheadPercent(900, 300), 100);
    assert.equal(playheadPercent(5, 0), 0);
  });

  it("a pointer maps to a frame, the right edge to the last frame", () => {
    assert.equal(frameFromPointer(0, 400, 300), 0);
    assert.equal(frameFromPointer(200, 400, 300), 150);
    assert.equal(frameFromPointer(399.9, 400, 300), 299);
    assert.equal(frameFromPointer(400, 400, 300), 299);
    assert.equal(frameFromPointer(-30, 400, 300), 0);
    assert.equal(frameFromPointer(10, 0, 300), 0);
  });

  it("roles map to lanes and bands: music alone, sfx and voice share the effects lane", () => {
    assert.equal(laneOfRole("music"), "music");
    assert.equal(laneOfRole("sfx"), "effects");
    assert.equal(laneOfRole("voice"), "effects");
    assert.equal(bandOfRole("voice"), "voice");
  });
});

describe("timeline keyboard and label", () => {
  const timeline = compileTimeline(
    {title: "T", scenes: [scene({duration: 3}), scene({duration: 2}), scene({duration: 1})]},
    FPS,
    {},
  );

  it("ArrowRight goes to the next scene start, then to the last frame", () => {
    assert.equal(seekTarget("ArrowRight", 0, timeline), 90);
    assert.equal(seekTarget("ArrowRight", 89, timeline), 90);
    assert.equal(seekTarget("ArrowRight", 90, timeline), 150);
    assert.equal(seekTarget("ArrowRight", 150, timeline), 179);
    assert.equal(seekTarget("ArrowRight", 179, timeline), 179);
  });

  it("ArrowLeft goes to the previous scene start, then to the first frame", () => {
    assert.equal(seekTarget("ArrowLeft", 179, timeline), 150);
    assert.equal(seekTarget("ArrowLeft", 150, timeline), 90);
    assert.equal(seekTarget("ArrowLeft", 100, timeline), 90);
    assert.equal(seekTarget("ArrowLeft", 90, timeline), 0);
    assert.equal(seekTarget("ArrowLeft", 0, timeline), 0);
  });

  it("Home and End go to the first and last frame; other keys are not handled", () => {
    assert.equal(seekTarget("Home", 100, timeline), 0);
    assert.equal(seekTarget("End", 10, timeline), 179);
    for (const key of ["ArrowUp", "ArrowDown", "Enter", " ", "a", "PageDown"]) {
      assert.equal(seekTarget(key, 10, timeline), null, key);
    }
  });

  it("the scene at a frame is the last one starting at or before it", () => {
    assert.deepEqual([0, 89, 90, 149, 150, 179].map((frame) => sceneIndexAtFrame(timeline, frame)), [0, 0, 1, 1, 2, 2]);
  });

  it("the label announces the current scene and the time", () => {
    assert.equal(timelineLabel(0, timeline, FPS), "Audio timeline, scene 1 of 3, 0:00 of 0:06");
    assert.equal(timelineLabel(100, timeline, FPS), "Audio timeline, scene 2 of 3, 0:03 of 0:06");
    assert.equal(timelineLabel(179, timeline, FPS), "Audio timeline, scene 3 of 3, 0:05 of 0:06");

    const long = compileTimeline({title: "T", scenes: [scene({duration: 125})]}, FPS, {});

    assert.equal(timelineLabel(3_700, long, FPS), "Audio timeline, scene 1 of 1, 2:03 of 2:05");
  });
});

describe("envelope sampling", () => {
  it("reads the plan's envelope once per column, at that column's centre frame", () => {
    const frames = [];
    const samples = sampleEnvelope((frame) => {
      frames.push(frame);

      return frame / 100;
    }, 100, 4);

    assert.deepEqual(frames, [12, 37, 62, 87]);
    assert.deepEqual([...samples], [0.12, 0.37, 0.62, 0.87].map(Math.fround));
  });

  it("never samples more columns than frames, keeps frames inside the Story and values inside 0 to 1", () => {
    const frames = [];
    const samples = sampleEnvelope((frame) => {
      frames.push(frame);

      return frame === 0 ? -3 : 9;
    }, 5, 1_000);

    assert.equal(samples.length, 5);
    assert.deepEqual(frames, [0, 1, 2, 3, 4]);
    assert.deepEqual([...samples], [0, 1, 1, 1, 1]);
    assert.equal(sampleEnvelope(() => 1, 5, 0).length, 0);
    assert.equal(sampleEnvelope(() => 1, 0, 10).length, 0);
    assert.equal(sampleEnvelope(() => 1, 5, Number.NaN).length, 0);
  });

  it("a music fade in rises along the plan's own envelope (no mixing in the UI)", () => {
    const view = viewFor(
      {title: "T", music: {src: MUSIC, fadeIn: 1}, scenes: [scene()]},
      {local: {[MUSIC]: 10}, sources: {[MUSIC]: url("music")}},
    );
    const samples = sampleEnvelope(view.plan.musicEnvelopeAt, 90, 90);

    assert.equal(samples[0] < 0.05, true);
    assert.equal(samples[15] > 0.4 && samples[15] < 0.6, true);
    assert.equal(samples[40], 1);
    assert.equal(samples[0], Math.fround(view.plan.musicEnvelopeAt(0)));
  });

  it("the envelope shows the ducking of a sound effect that the plan computed", () => {
    const view = fullView();
    const samples = sampleEnvelope(view.plan.musicEnvelopeAt, 270, 270);

    // The ding sounds for frames 0 to 36 and the 0.35 duck ramps back up after it.
    assert.equal(samples[30] < 0.4, true);
    assert.equal(samples[60], 1);
  });
});

describe("the editor's plan is the Player's plan", () => {
  it("compiles the very timeline and plan StoryAudio compiles from the same inputs", () => {
    const view = fullView();
    const durations = storyAudioDurations(fullStory, {[MUSIC]: 10, [VOICE]: 2.2});
    const direct = compileAudioPlan({
      story: fullStory,
      timeline: compileTimeline(fullStory, FPS, durations),
      fps: FPS,
      audioDurations: durations,
      sourceState: (ref) => audioSourceState(resolveAudioSrc(ref, fullSources, "explicit")),
    });

    assert.deepEqual(view.timeline, compileTimeline(fullStory, FPS, durations));
    assert.deepEqual(view.plan.tracks.map((track) => [track.key, track.fromFrame, track.durationInFrames]),
      direct.tracks.map((track) => [track.key, track.fromFrame, track.durationInFrames]));
    assert.deepEqual(view.plan.issues, direct.issues);
    assert.equal(view.plan.maxSimultaneousGain, direct.maxSimultaneousGain);
  });

  it("a bundled id without a source entry is pending under the explicit policy", () => {
    const view = viewFor({title: "T", scenes: [scene({sfx: {src: "ding"}})]});

    assert.deepEqual(view.plan.tracks, []);
    assert.deepEqual(view.plan.issues.map((issue) => issue.kind), ["pending-audio"]);
  });
});

describe("placeholder blocks for sounds without a track", () => {
  it("a missing local voice is a hatched block over its scene, labelled with its role", () => {
    const view = viewFor(
      {title: "T", scenes: [scene(), scene({voice: {src: VOICE}})]},
      {sources: {[VOICE]: {kind: "unavailable"}}},
    );
    const [block, ...rest] = timelinePlaceholders(view);

    assert.equal(rest.length, 0);
    assert.equal(block.appearance, "hatched");
    assert.equal(block.label, "Voice");
    assert.equal(block.lane, "effects");
    assert.equal(block.band, "voice");
    assert.deepEqual([block.leftPct, block.widthPct], [50, 50]);
  });

  it("an unusable or missing bundled sound is hatched, one still loading is plain, both with the catalog length", () => {
    const story = {title: "T", scenes: [scene({sfx: {src: "ding"}}), scene({sfx: {src: "pop"}})]};
    const view = viewFor(story, {sources: {ding: {kind: "unavailable"}, pop: {kind: "pending"}}});
    const blocks = timelinePlaceholders(view);

    assert.deepEqual(blocks.map((block) => [block.ref, block.appearance, block.label]), [
      ["ding", "hatched", "Sound effect"],
      ["pop", "plain", "Sound effect"],
    ]);
    // ding is 1.8 s = 54 frames of 180; pop is 0.25 s = round(7.5) = 8 frames starting at frame 90.
    assert.deepEqual([blocks[0].leftPct, blocks[0].widthPct], [0, (54 / 180) * 100]);
    assert.deepEqual([blocks[1].leftPct, blocks[1].widthPct], [50, (8 / 180) * 100]);
  });

  it("an sfx block is cut at the Story end and a voice block at its scene end; unknown lengths fall back to the scene", () => {
    const story = {
      title: "T",
      scenes: [scene({duration: 1}), scene({duration: 1, voice: {src: VOICE}, sfx: {src: MUSIC}})],
    };
    const view = viewFor(story, {
      local: {[VOICE]: 5, [MUSIC]: 5},
      sources: {[VOICE]: {kind: "pending"}, [MUSIC]: {kind: "pending"}},
    });
    const byRole = Object.fromEntries(timelinePlaceholders(view).map((block) => [block.role, block]));

    // The Story is 60 frames; scene 2 spans frames 30 to 60.
    assert.deepEqual([byRole.voice.leftPct, byRole.voice.widthPct], [50, 50]);
    assert.deepEqual([byRole.sfx.leftPct, byRole.sfx.widthPct], [50, 50]);

    const unknown = timelinePlaceholders(
      viewFor(story, {sources: {[VOICE]: {kind: "unavailable"}, [MUSIC]: {kind: "unavailable"}}}),
    );

    assert.deepEqual(unknown.map((block) => [block.leftPct, block.widthPct]), [[50, 50], [50, 50]]);
  });

  it("a placeholder has exactly the span its track will have once the sound is ready (the plan's own clamps)", () => {
    // ding (1.8 s) runs past its 1 s scene, pop is 0.25 s (8 frames), the 5 s voice is cut at its scene end,
    // and boom (3.2 s) is cut at the end of a Story that stops 6 frames after it starts.
    const story = {
      title: "T",
      scenes: [
        scene({duration: 1, sfx: {src: "ding"}}),
        scene({duration: 1, sfx: {src: "pop"}}),
        scene({duration: 1, voice: {src: VOICE}}),
        scene({duration: 0.2, sfx: {src: "boom"}}),
      ],
    };
    const refs = ["ding", "pop", "boom", VOICE];
    const waiting = viewFor(story, {
      local: {[VOICE]: 5},
      sources: Object.fromEntries(refs.map((ref) => [ref, {kind: "pending"}])),
    });
    const ready = viewFor(story, {
      local: {[VOICE]: 5},
      sources: Object.fromEntries(refs.map((ref) => [ref, url("x")])),
    });
    const blocks = timelinePlaceholders(waiting);

    assert.equal(blocks.length, 4);

    for (const block of blocks) {
      const track = ready.plan.tracks.find((candidate) => candidate.key === `${block.role}-${block.sceneIndex}`);

      assert.ok(track, block.key);
      assert.deepEqual(
        [block.leftPct, block.widthPct],
        [trackSpan(track, ready.timeline.durationInFrames).leftPct, trackSpan(track, ready.timeline.durationInFrames).widthPct],
        block.key,
      );
    }
  });

  it("missing music spans the whole Story in the music lane", () => {
    const view = viewFor(
      {title: "T", music: {src: "calm-loop"}, scenes: [scene(), scene()]},
      {sources: {"calm-loop": {kind: "unavailable"}}},
    );
    const [block] = timelinePlaceholders(view);

    assert.deepEqual([block.lane, block.role, block.appearance, block.leftPct, block.widthPct], ["music", "music", "hatched", 0, 100]);
  });

  it("other plan issues draw no block and a Story with every sound ready has none", () => {
    assert.deepEqual(timelinePlaceholders(fullView()), []);
    assert.deepEqual(timelinePlaceholders(viewFor({title: "T", scenes: [scene()]})), []);
  });
});

describe("lane drawing", () => {
  const peaks = {peaksPerSecond: 50, peaks: Uint8Array.from({length: 600}, () => 200)};
  const waveforms = new Map([["ding", peaks], [MUSIC, peaks], [VOICE, peaks]]);

  it("draws a sound effect in the upper band at its fromFrame and a voice in the lower band, clipped to the track", () => {
    const view = fullView();
    const {calls, context} = recorder();

    drawEffectsLane(context, {view, waveforms, width: 270, height: 64});

    const bars = fills(calls);
    const ding = bars.filter(([, , y, , h]) => y + h <= 32 + 1e-9);
    const voice = bars.filter(([, , y]) => y >= 32 - 1e-9 && y < 64);

    assert.equal(ding.length + voice.length, bars.length);
    // ding: frames 0 to 54 of 270 on a 270 px canvas = x 0 to 54; voice: frames 90 to 156.
    assert.equal(Math.min(...ding.map(([, x]) => x)), 0);
    assert.equal(Math.max(...ding.map(([, x, , w]) => x + w)) <= 54.5, true);
    assert.ok(Math.abs(Math.min(...voice.map(([, x]) => x)) - 90) < 1e-6);
    assert.equal(Math.max(...voice.map(([, x, , w]) => x + w)) <= 156.5, true);
    assert.equal(calls[0][0], "clear");
  });

  it("draws the music waveform per plan copy and the plan's envelope as one line with one point per column", () => {
    const story = {title: "T", music: {src: MUSIC, fadeIn: 1}, scenes: [scene({duration: 20})]};
    const view = viewFor(story, {local: {[MUSIC]: 10}, sources: {[MUSIC]: url("music")}});
    const {calls, context} = recorder();

    // 10 s of music in a 20 s Story (600 frames) loops: three copies, at frames 0, 291 and 582.
    assert.equal(view.plan.tracks.filter((track) => track.role === "music").length, 3);
    drawMusicLane(context, {view, waveforms, width: 300, height: 48});

    const line = calls.filter(([kind]) => kind === "move" || kind === "line");

    assert.equal(line.length, 300);
    assert.equal(calls.filter(([kind]) => kind === "stroke").length, 1);
    // The fade in starts silent (line at the bottom) and reaches full level (top).
    assert.equal(line[0][2] > 40, true);
    assert.equal(Math.min(...line.map(([, , y]) => y)), 0);
    assert.equal(Math.max(...fills(calls).map(([, x, , w]) => x + w)) <= 300.5, true);
  });

  it("draws no envelope line when the music has no track", () => {
    const view = viewFor(
      {title: "T", music: {src: MUSIC}, scenes: [scene()]},
      {sources: {[MUSIC]: {kind: "pending"}}},
    );
    const {calls, context} = recorder();

    drawMusicLane(context, {view, waveforms, width: 200, height: 48});
    assert.deepEqual(calls.map(([kind]) => kind), ["clear"]);
  });

  it("draws a track whose peaks are unknown as a quiet flat bar, and nothing for a lane without sounds", () => {
    const view = fullView();
    const {calls, context} = recorder();

    drawEffectsLane(context, {view, waveforms: new Map(), width: 270, height: 64});
    assert.equal(fills(calls).length > 0, true);
    assert.equal(fills(calls).every(([, , , , height]) => height <= 32 * 0.1), true);

    const silent = recorder();

    drawEffectsLane(silent.context, {view: viewFor({title: "T", scenes: [scene()]}), waveforms, width: 270, height: 64});
    assert.deepEqual(silent.calls.map(([kind]) => kind), ["clear"]);
  });

  it("drawing is a pure function of the plan: the same inputs record the same calls", () => {
    const view = fullView();
    const first = recorder();
    const second = recorder();

    drawMusicLane(first.context, {view, waveforms, width: 321, height: 48});
    drawMusicLane(second.context, {view, waveforms, width: 321, height: 48});
    assert.deepEqual(first.calls, second.calls);
  });
});
