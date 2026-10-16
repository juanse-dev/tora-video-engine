import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {storyAudioDurations} from "../src/audio/storyAudio.ts";
import {compileEditorAudioPlan} from "../src/web/audio/audioPlanView.ts";
import {
  AUDIO_NOT_AVAILABLE_MESSAGE,
  AUDIO_NOT_LOADED_MESSAGE,
  FADES_SCALED_MESSAGE,
  MUSIC_TOO_SHORT_MESSAGE,
  NO_AUDIO_NOTICES,
  audioFieldNotices,
  clipMessage,
  voiceCutMessage,
} from "../src/web/audio/audioNotices.ts";

const FPS = 30;
const LOCAL = `local:audio:sha256:${"d".repeat(64)}`;
const VOICE = `local:audio:sha256:${"e".repeat(64)}`;
const scene = (extra = {}) => ({
  type: "dialogue",
  pose: "formal",
  background: "office",
  text: "Hi",
  duration: 3,
  ...extra,
});
const url = (name) => ({kind: "url", url: `blob:http://localhost/${name}`});
const noticesFor = (story, {local = {}, sources = {}, bundled = new Map()} = {}) =>
  audioFieldNotices(
    compileEditorAudioPlan({
      story,
      fps: FPS,
      audioDurations: storyAudioDurations(story, local),
      audioSources: sources,
    }),
    bundled,
  );
const texts = (notices) => notices.map((notice) => notice.text);

describe("the warning texts", () => {
  it("have the copy of the spec", () => {
    assert.equal(AUDIO_NOT_AVAILABLE_MESSAGE, "Audio not available: render blocked.");
    assert.equal(AUDIO_NOT_LOADED_MESSAGE, "Audio could not be loaded.");
    assert.equal(FADES_SCALED_MESSAGE, "Fades shortened to fit the Story.");
    assert.equal(MUSIC_TOO_SHORT_MESSAGE, "This music is too short to loop (under 1 s); it plays once.");
    assert.equal(voiceCutMessage(1.2), "Voice is cut by 1.2 s.");
    assert.equal(voiceCutMessage(0.05), "Voice is cut by 0.1 s.");
    // One frame at 30 FPS is the smallest cut the plan reports: it must not read 0.0 s.
    assert.equal(voiceCutMessage(1 / 30), "Voice is cut by 0.1 s.");
    assert.equal(voiceCutMessage(0.1), "Voice is cut by 0.1 s.");
    assert.equal(voiceCutMessage(1.25), "Voice is cut by 1.3 s.");
    assert.equal(voiceCutMessage(2), "Voice is cut by 2.0 s.");
    assert.equal(clipMessage(1.4), "The mix may clip (peak gain 1.4).");
  });

  it("a clipping peak is rounded up, so it never reads 1.0", () => {
    assert.equal(clipMessage(1.0001), "The mix may clip (peak gain 1.1).");
    assert.equal(clipMessage(Math.SQRT2), "The mix may clip (peak gain 1.5).");
    assert.equal(clipMessage(2), "The mix may clip (peak gain 2.0).");
  });
});

describe("audioFieldNotices", () => {
  it("has no warnings for a Story without audio or with every sound ready", () => {
    assert.equal(noticesFor({title: "T", scenes: [scene()]}), NO_AUDIO_NOTICES);
    assert.equal(
      noticesFor(
        {title: "T", scenes: [scene({sfx: {src: "ding"}})]},
        {sources: {ding: url("ding")}},
      ),
      NO_AUDIO_NOTICES,
    );
  });

  it("puts Audio not available on the field whose sound is missing, per role and scene", () => {
    const story = {
      title: "T",
      music: {src: "calm-loop"},
      scenes: [scene({sfx: {src: LOCAL}}), scene({voice: {src: VOICE}})],
    };
    const notices = noticesFor(story, {
      sources: {"calm-loop": {kind: "unavailable"}, [LOCAL]: {kind: "unavailable"}, [VOICE]: {kind: "unavailable"}},
    });

    assert.deepEqual(texts(notices.music), [AUDIO_NOT_AVAILABLE_MESSAGE]);
    assert.deepEqual(texts(notices.scenes.get(0).sfx), [AUDIO_NOT_AVAILABLE_MESSAGE]);
    assert.deepEqual(notices.scenes.get(0).voice, []);
    assert.deepEqual(texts(notices.scenes.get(1).voice), [AUDIO_NOT_AVAILABLE_MESSAGE]);
    assert.deepEqual(notices.scenes.get(1).sfx, []);
  });

  it("a sound that is only loading has no warning text; a bundled one that could not be fetched gets the text and a Retry", () => {
    const story = {title: "T", scenes: [scene({sfx: {src: "ding"}}), scene({sfx: {src: "pop"}})]};
    const sources = {ding: {kind: "pending"}, pop: {kind: "pending"}};
    const loading = noticesFor(story, {
      sources,
      bundled: new Map([["ding", {kind: "loading"}], ["pop", {kind: "retrying", attempt: 2}]]),
    });

    assert.deepEqual(loading, NO_AUDIO_NOTICES);

    const failed = noticesFor(story, {
      sources,
      bundled: new Map([["ding", {kind: "fetch-failed", message: "x"}], ["pop", {kind: "retrying", attempt: 3}]]),
    });

    assert.deepEqual(failed.scenes.get(0).sfx, [
      {text: "Audio could not be loaded.", retry: {id: "ding", label: "Ding"}},
    ]);
    assert.equal(failed.scenes.has(1), false);
  });

  it("a pending local sound never gets a warning or a Retry", () => {
    const notices = noticesFor(
      {title: "T", scenes: [scene({voice: {src: VOICE}})]},
      {sources: {[VOICE]: {kind: "pending"}}},
    );

    assert.deepEqual(notices, NO_AUDIO_NOTICES);
  });

  it("warns that a voice is cut, with the plan's seconds, on that scene's voice", () => {
    const story = {title: "T", scenes: [scene({duration: 1}), scene({duration: 1, voice: {src: VOICE}})]};
    const notices = noticesFor(story, {local: {[VOICE]: 2.2}, sources: {[VOICE]: url("voice")}});

    assert.deepEqual(texts(notices.scenes.get(1).voice), ["Voice is cut by 1.2 s."]);
    assert.equal(notices.scenes.has(0), false);
    assert.deepEqual(notices.music, []);
  });

  it("a voice only a frame longer than its scene says 0.1 s, not 0.0 s", () => {
    const story = {title: "T", scenes: [scene({duration: 2.2, voice: {src: VOICE}})]};
    const notices = noticesFor(story, {local: {[VOICE]: 2.2 + 1 / 30}, sources: {[VOICE]: url("voice")}});

    assert.deepEqual(texts(notices.scenes.get(0).voice), ["Voice is cut by 0.1 s."]);
  });

  it("an auto scene is never cut", () => {
    const story = {title: "T", scenes: [scene({duration: "auto", voice: {src: VOICE}})]};

    assert.equal(noticesFor(story, {local: {[VOICE]: 2.2}, sources: {[VOICE]: url("voice")}}), NO_AUDIO_NOTICES);
  });

  it("warns on the music panel when the fades do not fit, when the music is too short to loop and when the mix may clip", () => {
    const fades = noticesFor(
      {title: "T", music: {src: LOCAL, fadeIn: 2, fadeOut: 2}, scenes: [scene({duration: 3})]},
      {local: {[LOCAL]: 10}, sources: {[LOCAL]: url("m")}},
    );

    assert.deepEqual(texts(fades.music), [FADES_SCALED_MESSAGE]);

    const short = noticesFor(
      {title: "T", music: {src: "pop"}, scenes: [scene()]},
      {sources: {pop: url("pop")}},
    );

    assert.deepEqual(texts(short.music), [MUSIC_TOO_SHORT_MESSAGE]);

    // Full-volume looping music crosses over at sqrt(2); a sound effect on top is not needed.
    const loop = noticesFor(
      {title: "T", music: {src: LOCAL}, scenes: [scene({duration: 20})]},
      {local: {[LOCAL]: 10}, sources: {[LOCAL]: url("m")}},
    );

    assert.deepEqual(texts(loop.music), ["The mix may clip (peak gain 1.5)."]);

    const quiet = noticesFor(
      {title: "T", music: {src: LOCAL, volume: 0.5}, scenes: [scene({duration: 20})]},
      {local: {[LOCAL]: 10}, sources: {[LOCAL]: url("m")}},
    );

    assert.equal(quiet, NO_AUDIO_NOTICES);
  });

  it("a Story with music and an effect at full volume that sum above 1 clips", () => {
    const story = {
      title: "T",
      music: {src: LOCAL, duck: 1},
      scenes: [scene({sfx: {src: "ding"}})],
    };
    const notices = noticesFor(story, {local: {[LOCAL]: 10}, sources: {[LOCAL]: url("m"), ding: url("ding")}});

    assert.deepEqual(texts(notices.music), ["The mix may clip (peak gain 2.0)."]);
  });
});
