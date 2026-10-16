import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  audioFileUnusableMessage,
  bundledAudioMismatchMessage,
  bundledAudioUnavailableMessage,
  collectStoryAudioRefs,
  describeAudioRefRoles,
  describeAudioRole,
} from "../src/audio/readiness.ts";

const VOICE = `local:audio:sha256:${"a".repeat(64)}`;
const scene = (overrides = {}) => ({
  type: "dialogue",
  pose: "formal",
  background: "office",
  text: "Hi",
  duration: 3,
  ...overrides,
});

describe("collectStoryAudioRefs", () => {
  it("lists every use in reading order: music first, then each scene's sfx and voice", () => {
    const story = {
      title: "Uses",
      music: {src: "calm-loop"},
      scenes: [
        scene(),
        scene({sfx: {src: "ding"}, voice: {src: VOICE}}),
        scene({voice: {src: "ding"}}),
      ],
    };

    assert.deepEqual(collectStoryAudioRefs(story), [
      {ref: "calm-loop", role: "music", sceneIndex: null},
      {ref: "ding", role: "sfx", sceneIndex: 1},
      {ref: VOICE, role: "voice", sceneIndex: 1},
      {ref: "ding", role: "voice", sceneIndex: 2},
    ]);
  });

  it("is empty for a Story without audio", () => {
    assert.deepEqual(collectStoryAudioRefs({title: "Silent", scenes: [scene()]}), []);
  });
});

describe("audio role text", () => {
  it("names the music and numbers scenes from 1", () => {
    assert.equal(describeAudioRole("music", null), "music");
    assert.equal(describeAudioRole("sfx", 2), "scene 3 sfx");
    assert.equal(describeAudioRole("voice", 0), "scene 1 voice");
  });

  it("lists every role of one ref in Story order", () => {
    const story = {
      title: "Uses",
      music: {src: "ding"},
      scenes: [scene({sfx: {src: "ding"}}), scene({voice: {src: "ding"}})],
    };

    assert.deepEqual(describeAudioRefRoles(story, "ding"), [
      "music",
      "scene 1 sfx",
      "scene 2 voice",
    ]);
    assert.deepEqual(describeAudioRefRoles(story, "pop"), []);
  });

  it("uses the exact user-facing sentences", () => {
    assert.equal(
      bundledAudioUnavailableMessage("calm-loop"),
      "Bundled audio calm-loop is not available in this build.",
    );
    assert.equal(
      bundledAudioMismatchMessage("ding"),
      "Bundled audio ding does not match the catalog.",
    );
    assert.equal(
      audioFileUnusableMessage("voice.wav"),
      "Audio file voice.wav cannot be used for rendering.",
    );
  });
});
