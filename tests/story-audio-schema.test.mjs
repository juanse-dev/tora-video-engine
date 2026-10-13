import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {StorySchema} from "../src/story/schema.ts";
import {storyAudioRefs, storyHasAudio} from "../src/audio/storyAudio.ts";

const voice = `local:audio:sha256:${"b".repeat(64)}`;
const scene = (o = {}) => ({type: "intro", pose: "formal", background: "office", text: "Hi", duration: 3, ...o});
const story = (o = {}, scenes = [scene()]) => ({title: "T", scenes, ...o});
const issues = (s) => {
  const r = StorySchema.safeParse(s);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("audio schema", () => {
  it("accepts every audio field at its bounds", () => {
    assert.deepEqual(issues(story(
      {music: {src: "boom", volume: 0, fadeIn: 0, fadeOut: 10, duck: 1}},
      [scene({sfx: {src: "ding", volume: 1}, voice: {src: voice}, duration: "auto"})],
    )), []);
  });

  for (const [field, value] of [["volume", -0.01], ["volume", 1.01], ["volume", Number.NaN], ["duck", 2], ["fadeIn", -1], ["fadeOut", 10.01]]) {
    it(`rejects music.${field} = ${value}`, () => {
      assert.ok(issues(story({music: {src: "boom", [field]: value}})).some((m) => m.startsWith(`music.${field}`)));
    });
  }

  it("rejects unknown keys in every audio object", () => {
    assert.ok(issues(story({music: {src: "boom", loop: true}})).length > 0);
    assert.ok(issues(story({}, [scene({sfx: {src: "boom", trim: 1}})])).length > 0);
    assert.ok(issues(story({}, [scene({voice: {src: voice, offset: 1}})])).length > 0);
  });

  it("rejects a non-audio src with the spec message", () => {
    const messages = issues(story({}, [scene({sfx: {src: "office"}})]));
    assert.ok(messages.includes("scenes.0.sfx.src: Audio must be whoosh, boom, ding, pop, calm-loop, upbeat-loop, or local:audio:sha256:<64 lowercase hex>"), messages.join("\n"));
  });

  it("requires a voice for duration: auto", () => {
    assert.deepEqual(issues(story({}, [scene({duration: "auto"})])), ["scenes.0.duration: duration: auto requires a voice"]);
  });

  it("keeps today's duration messages for non-auto values", () => {
    const tooSmall = "scenes.0.duration: Too small: expected number to be >0";
    const frames = "scenes.0.duration: Duration must produce a finite safe frame count of at least 1 at 30 FPS";
    const expected = [
      [-1, [tooSmall, frames]],
      [0, [tooSmall, frames]],
      [Number.NaN, ["scenes.0.duration: Invalid input: expected number, received NaN"]],
      ["3", ["scenes.0.duration: Invalid input: expected number, received string"]],
      ["AUTO", ["scenes.0.duration: Invalid input: expected number, received string"]],
      [null, ["scenes.0.duration: Invalid input: expected number, received null"]],
    ];
    for (const [value, messages] of expected) {
      assert.deepEqual(issues(story({}, [scene({duration: value})])), messages, String(value));
    }
    const {duration: _omitted, ...withoutDuration} = scene();
    assert.deepEqual(issues(story({}, [withoutDuration])), ["scenes.0.duration: Invalid input: expected number, received undefined"], "missing duration");
  });

  it("ignores auto scenes in the story frame-total check", () => {
    assert.deepEqual(issues(story({}, [scene({voice: {src: voice}, duration: "auto"}), scene()])), []);
  });
});

describe("storyHasAudio", () => {
  it("is false for a bundled-only story and true for each feature alone", () => {
    assert.equal(storyHasAudio(story()), false);
    assert.equal(storyHasAudio(story({music: {src: "boom"}})), true);
    assert.equal(storyHasAudio(story({}, [scene({sfx: {src: "boom"}})])), true);
    assert.equal(storyHasAudio(story({}, [scene({voice: {src: voice}})])), true);
    assert.equal(storyHasAudio(story({}, [scene({voice: {src: voice}, duration: "auto"})])), true);
  });

  it("lists refs music first, then sfx/voice by scene, without duplicates", () => {
    const s = story({music: {src: "boom"}}, [scene({sfx: {src: "ding"}, voice: {src: voice}}), scene({sfx: {src: "boom"}})]);
    assert.deepEqual(storyAudioRefs(s), ["boom", "ding", voice]);
  });
});
