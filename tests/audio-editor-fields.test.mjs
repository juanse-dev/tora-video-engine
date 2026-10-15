import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {bundledAudioCatalog} from "../src/audio/catalog.ts";
import {buildLocalAssetRef} from "../src/localAssets/refs.ts";
import {
  MUSIC_DEFAULTS,
  NO_AUDIO_VALUE,
  audioSelectOptions,
  autoDurationText,
  autoSceneView,
  setDraftMusicNumber,
  setDraftMusicSource,
  setSceneAudioVolume,
  setSceneAuto,
  setSceneSfxSource,
  setSceneVoiceSource,
} from "../src/web/audio/audioFields.ts";
import {readLibraryAudioOptions} from "../src/web/audio/libraryAudioOptions.ts";
import {LOCAL_ASSET_PAGE_SIZE} from "../src/web/assetLibrary/constants.ts";
import {
  evaluateVisualDraft,
  replaceVisualScene,
  storyToVisualDraft,
} from "../src/web/visualDraft.ts";
import {createMemoryAssetStore} from "./helpers/memoryAssetStore.mjs";

const digestOf = (n) => n.toString(16).padStart(64, "0");
const audioRef = (n) => buildLocalAssetRef("audio", digestOf(n));
const VOICE = audioRef(1);
const FPS = 30;
const baseScene = (extra = {}) => ({
  type: "dialogue",
  pose: "formal",
  background: "office",
  text: "Hello",
  duration: 3,
  ...extra,
});
const draftOf = (story) => storyToVisualDraft({title: "T", ...story});
const candidateOf = (draft) => {
  const result = evaluateVisualDraft(draft);

  assert.equal(result.kind, "eligible", JSON.stringify(result.errors));

  return result.story;
};

describe("audioSelectOptions", () => {
  const library = [
    {ref: audioRef(5), label: "Echo"},
    {ref: audioRef(3), label: "banana"},
    {ref: audioRef(2), label: "Apple"},
    {ref: audioRef(4), label: "Echo"},
  ];

  it("offers the four bundled effects and no music while the music files are not supplied", () => {
    const groups = audioSelectOptions({current: undefined, library: []});

    assert.deepEqual(
      groups.bundled.map((option) => option.value),
      ["whoosh", "boom", "ding", "pop"],
    );
    assert.equal(groups.bundled.some((option) => option.value.endsWith("-loop")), false);
    assert.equal(groups.current, null);
  });

  it("lists music before effects and leaves out every entry whose file is null", () => {
    const catalog = {
      ...bundledAudioCatalog,
      "calm-loop": {...bundledAudioCatalog["calm-loop"], file: "audio/music/calm-loop.mp3", durationSeconds: 60},
    };
    const groups = audioSelectOptions({current: undefined, library: [], catalog});

    assert.deepEqual(
      groups.bundled.map((option) => option.value),
      ["calm-loop", "whoosh", "boom", "ding", "pop"],
    );
    assert.equal(groups.bundled[0].label, "Calm loop");
  });

  it("sorts My audio by label (ignoring case), then by ref, whatever order the library returned", () => {
    const groups = audioSelectOptions({current: undefined, library});

    assert.deepEqual(
      groups.library.map((option) => option.value),
      [audioRef(2), audioRef(3), audioRef(4), audioRef(5)],
    );
  });

  it("labels that differ only in case tie, so the ref decides (accents stay distinct)", () => {
    const tied = [
      {ref: audioRef(9), label: "echo"},
      {ref: audioRef(8), label: "ECHO"},
      {ref: audioRef(7), label: "Echo"},
      {ref: audioRef(6), label: "Écho"},
      {ref: audioRef(5), label: "Zulu"},
    ];
    const values = audioSelectOptions({current: undefined, library: tied}).library.map((option) => option.value);

    // The three spellings of echo come out by ref (7, 8, 9), then the accented one, then Zulu.
    assert.deepEqual(values, [audioRef(7), audioRef(8), audioRef(9), audioRef(6), audioRef(5)]);
  });

  it("tells two library rows with the same label apart: the duration, then a short id when that is equal too", () => {
    const rows = [
      {ref: audioRef(1), label: "voice", durationSeconds: 2.2},
      {ref: audioRef(2), label: "voice", durationSeconds: 10},
      {ref: audioRef(3), label: "take", durationSeconds: 4},
      {ref: audioRef(4), label: "take", durationSeconds: 4.3},
      {ref: audioRef(5), label: "solo", durationSeconds: 7},
      {ref: audioRef(6), label: "mute"},
      {ref: audioRef(7), label: "mute"},
      {ref: audioRef(8), label: "Voice", durationSeconds: 3},
    ];
    const labels = audioSelectOptions({current: undefined, library: rows}).library.map((option) => option.label);

    assert.deepEqual(labels, [
      "mute · 0000…0006",
      "mute · 0000…0007",
      "solo",
      "take (0:04) · 0000…0003",
      "take (0:04) · 0000…0004",
      "voice (0:02)",
      "voice (0:10)",
      "Voice",
    ]);
  });

  it("keeps a value the Story holds selectable when no group offers it", () => {
    const missing = audioSelectOptions({current: audioRef(9), library});
    const noFile = audioSelectOptions({current: "calm-loop", library});

    assert.deepEqual(missing.current, {value: audioRef(9), label: "Missing audio 0000…0009"});
    assert.deepEqual(noFile.current, {value: "calm-loop", label: "Calm loop (not available)"});
  });

  it("does not repeat a value a group already offers", () => {
    assert.equal(audioSelectOptions({current: "ding", library}).current, null);
    assert.equal(audioSelectOptions({current: audioRef(3), library}).current, null);
  });

  it("the None option has the empty value", () => {
    assert.equal(NO_AUDIO_VALUE, "");
  });
});

describe("music fields", () => {
  const bare = draftOf({scenes: [baseScene()]});

  it("selecting a track creates music with only its src, and None removes it", () => {
    const withMusic = setDraftMusicSource(bare, "calm-loop");

    assert.deepEqual(withMusic.music, {src: "calm-loop"});
    assert.deepEqual(candidateOf(withMusic).music, {src: "calm-loop"});
    assert.equal("music" in setDraftMusicSource(withMusic, null), false);
    assert.equal("music" in candidateOf(setDraftMusicSource(withMusic, null)), false);
  });

  it("changing the track keeps the volume, fades and ducking", () => {
    const tuned = setDraftMusicNumber(setDraftMusicSource(bare, "calm-loop"), "volume", 0.6);

    assert.deepEqual(setDraftMusicSource(tuned, VOICE).music, {src: VOICE, volume: 0.6});
  });

  it("a value equal to its default is omitted, any other value is written", () => {
    let draft = setDraftMusicSource(bare, "calm-loop");

    draft = setDraftMusicNumber(draft, "volume", 0.6);
    draft = setDraftMusicNumber(draft, "duck", 0.5);
    draft = setDraftMusicNumber(draft, "fadeIn", 0.5);
    draft = setDraftMusicNumber(draft, "fadeOut", 1.5);
    assert.deepEqual(draft.music, {src: "calm-loop", volume: 0.6, duck: 0.5, fadeIn: 0.5, fadeOut: 1.5});

    for (const field of Object.keys(MUSIC_DEFAULTS)) {
      draft = setDraftMusicNumber(draft, field, MUSIC_DEFAULTS[field]);
    }

    assert.deepEqual(draft.music, {src: "calm-loop"});
    assert.deepEqual(MUSIC_DEFAULTS, {volume: 1, duck: 0.35, fadeIn: 0, fadeOut: 0});
  });

  it("changing a number without music changes nothing", () => {
    assert.equal(setDraftMusicNumber(bare, "volume", 0.2), bare);
  });

  it("an out-of-range fade is a schema-invalid pending candidate with the field's error", () => {
    const draft = setDraftMusicNumber(setDraftMusicSource(bare, "calm-loop"), "fadeIn", 11);
    const result = evaluateVisualDraft(draft);

    assert.equal(result.kind, "schema-invalid");
    assert.ok(result.errors["music.fadeIn"]);
  });

  it("a Story without audio keeps exactly the keys it had", () => {
    const untouched = setDraftMusicSource(bare, null);

    assert.deepEqual(Object.keys(untouched), ["title", "scenes"]);
    assert.deepEqual(untouched.scenes, bare.scenes);
  });
});

describe("scene sound fields", () => {
  const scene = draftOf({scenes: [baseScene()]}).scenes[0];

  it("sets and removes the sound effect and keeps its volume across a change of sound", () => {
    const withSfx = setSceneSfxSource(scene, "ding");

    assert.deepEqual(withSfx.sfx, {src: "ding"});

    const louder = setSceneAudioVolume(withSfx, "sfx", 0.5);

    assert.deepEqual(setSceneSfxSource(louder, "boom").sfx, {src: "boom", volume: 0.5});
    assert.equal("sfx" in setSceneSfxSource(louder, null), false);
  });

  it("a volume equal to the default is omitted; without a clip nothing changes", () => {
    const withSfx = setSceneAudioVolume(setSceneSfxSource(scene, "ding"), "sfx", 0.5);

    assert.deepEqual(setSceneAudioVolume(withSfx, "sfx", 1).sfx, {src: "ding"});
    assert.equal(setSceneAudioVolume(scene, "voice", 0.5), scene);
  });

  it("the voice keeps its own volume when the sound changes", () => {
    const withVoice = setSceneAudioVolume(setSceneVoiceSource(scene, VOICE, 2.7), "voice", 0.8);

    assert.deepEqual(setSceneVoiceSource(withVoice, audioRef(2), 2.7).voice, {src: audioRef(2), volume: 0.8});
  });
});

describe("Auto (from voice)", () => {
  const withVoice = draftOf({scenes: [baseScene({voice: {src: VOICE}, duration: 4})]});
  const scene = withVoice.scenes[0];

  it("cannot be checked without a voice", () => {
    const silent = draftOf({scenes: [baseScene()]}).scenes[0];

    assert.equal(setSceneAuto(silent, true, 2.7), silent);
  });

  it("checking remembers the number and unchecking restores it", () => {
    const auto = setSceneAuto(scene, true, 2.7);

    assert.equal(auto.duration, "auto");
    assert.equal(auto.lastDuration, "4");
    assert.equal(candidateOf(replaceVisualScene(withVoice, 0, auto)).scenes[0].duration, "auto");

    const restored = setSceneAuto(auto, false, 2.7);

    assert.equal(restored.duration, "4");
    assert.equal("lastDuration" in restored, false);
    assert.equal(setSceneAuto(scene, false, 2.7), scene);
    assert.equal(setSceneAuto(auto, true, 2.7), auto);
  });

  it("unchecking a scene that came from YAML as auto restores the resolved seconds rounded to 0.1 s", () => {
    const fromYaml = draftOf({scenes: [baseScene({voice: {src: VOICE}, duration: "auto"})]}).scenes[0];

    assert.equal(setSceneAuto(fromYaml, false, 81 / FPS).duration, "2.7");
    assert.equal(setSceneAuto(fromYaml, false, 3).duration, "3");
    assert.equal(setSceneAuto(fromYaml, false, 4.33333).duration, "4.3");
  });

  it("an unusable remembered duration is ignored", () => {
    for (const lastDuration of ["", "  ", "abc", "0", "-1"]) {
      const auto = {...setSceneAuto(scene, true, 2.7), lastDuration};

      assert.equal(setSceneAuto(auto, false, 2.7).duration, "2.7", JSON.stringify(lastDuration));
    }
  });

  it("choosing Voice None on an auto scene is ONE valid edit that also restores the number", () => {
    const auto = setSceneAuto(scene, true, 2.7);
    const draft = replaceVisualScene(withVoice, 0, auto);
    const cleared = replaceVisualScene(draft, 0, setSceneVoiceSource(auto, null, 2.7));
    const story = candidateOf(cleared);

    assert.equal("voice" in story.scenes[0], false);
    assert.equal(story.scenes[0].duration, 4);
    assert.equal("lastDuration" in cleared.scenes[0], false);
  });

  it("Voice None on an auto scene read from YAML uses the resolved seconds rounded to 0.1 s", () => {
    const fromYaml = draftOf({scenes: [baseScene({voice: {src: VOICE}, duration: "auto"})]});
    const cleared = replaceVisualScene(fromYaml, 0, setSceneVoiceSource(fromYaml.scenes[0], null, 81 / FPS));
    const story = candidateOf(cleared);

    assert.equal(story.scenes[0].duration, 2.7);
    assert.equal("voice" in story.scenes[0], false);
  });

  it("Voice None on a numeric scene only removes the voice", () => {
    const cleared = setSceneVoiceSource(scene, null, 2.7);

    assert.equal(cleared.duration, "4");
    assert.equal("voice" in cleared, false);
  });

  it("the lastDuration memory never reaches the candidate Story", () => {
    const auto = setSceneAuto(scene, true, 2.7);
    const story = candidateOf(replaceVisualScene(withVoice, 0, auto));

    assert.deepEqual(Object.keys(story.scenes[0]).sort(), ["background", "duration", "pose", "text", "type", "voice"]);
  });
});

describe("the text of an auto scene", () => {
  it("shows the timeline's seconds for a known voice and a hint for the fallback", () => {
    const known = autoSceneView({voice: {src: VOICE}}, {[VOICE]: 2.2}, FPS);
    const long = autoSceneView({voice: {src: VOICE}}, {[VOICE]: 3.8}, FPS);
    const unknown = autoSceneView({voice: {src: VOICE}}, {}, FPS);

    assert.deepEqual(known, {seconds: 81 / FPS, source: "voice"});
    assert.equal(autoDurationText(known), "auto · 2.7 s");
    assert.equal(autoDurationText(long), "auto · 4.3 s");
    assert.equal(autoDurationText(unknown), "auto · voice not available");
    assert.equal(unknown.seconds, 3);
  });
});

describe("readLibraryAudioOptions", () => {
  const seed = (store, n, row = {}) =>
    store.setRaw("assets", audioRef(n), {
      label: `Sound ${n}`,
      originalFilename: `sound-${n}.mp3`,
      createdAt: "2026-01-02T03:04:05.000Z",
      ...row,
    });

  it("reads every present row across library pages and skips damaged rows", async () => {
    const store = createMemoryAssetStore();
    const total = LOCAL_ASSET_PAGE_SIZE * 2 + 3;

    for (let n = 1; n <= total; n += 1) {
      seed(store, n);
    }

    store.setRaw("assets", audioRef(total + 1), {label: 42});

    const options = await readLibraryAudioOptions(store);

    assert.equal(options.length, total);
    assert.deepEqual(options[0], {ref: audioRef(1), label: "Sound 1"});
    assert.equal(options.at(-1).ref, audioRef(total));
    assert.equal(options.some((option) => option.ref === audioRef(total + 1)), false);
  });

  it("reads the duration only for rows whose label another row shares", async () => {
    const store = createMemoryAssetStore();
    const meta = (durationSeconds) => ({
      kind: "audio",
      mimeType: "audio/wav",
      byteSize: 10,
      container: "wave",
      codec: "pcm",
      durationSeconds,
      sampleRate: 48_000,
      channels: 2,
    });

    seed(store, 1, {label: "voice"});
    seed(store, 2, {label: "voice"});
    seed(store, 3, {label: "solo"});
    seed(store, 4, {label: "voice"});
    store.setRaw("payloadMeta", digestOf(1), meta(2.2));
    store.setRaw("payloadMeta", digestOf(2), meta(10));
    store.setRaw("payloadMeta", digestOf(3), meta(7));
    // Row 4 has no metadata: it simply has no duration.

    const rows = await readLibraryAudioOptions(store);

    assert.deepEqual(rows.map((row) => [row.label, row.durationSeconds]), [
      ["voice", 2.2],
      ["voice", 10],
      ["solo", undefined],
      ["voice", undefined],
    ]);
  });

  it("is empty for an empty library", async () => {
    assert.deepEqual(await readLibraryAudioOptions(createMemoryAssetStore()), []);
  });

  it("has no cap: 120 rows over three pages are all listed, and the select offers all of them sorted by label", async () => {
    const store = createMemoryAssetStore();
    const total = 120;

    assert.ok(total > LOCAL_ASSET_PAGE_SIZE * 2);

    // Labels are in a different order from the refs (the library's storage order).
    for (let n = 1; n <= total; n += 1) {
      seed(store, n, {label: `Sound ${String(total + 1 - n).padStart(3, "0")}`});
    }

    const rows = await readLibraryAudioOptions(store);

    assert.equal(rows.length, total);
    assert.equal(new Set(rows.map((row) => row.ref)).size, total);

    const groups = audioSelectOptions({current: audioRef(1), library: rows});

    assert.equal(groups.library.length, total);
    assert.equal(groups.current, null, "the last-stored ref is offered, not replaced by a Missing option");
    assert.deepEqual(
      groups.library.map((option) => option.label),
      Array.from({length: total}, (_, index) => `Sound ${String(index + 1).padStart(3, "0")}`),
    );
  });

  it("stops reading when aborted", async () => {
    const store = createMemoryAssetStore();
    const controller = new AbortController();

    seed(store, 1);
    controller.abort();
    await assert.rejects(readLibraryAudioOptions(store, controller.signal), {name: "AbortError"});
  });
});
