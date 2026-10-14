import assert from "node:assert/strict";
import {describe, it, mock} from "node:test";
import {staticFile} from "remotion";
import {bundledAudioCatalog} from "../src/audio/catalog.ts";
import {compileAudioPlan} from "../src/audio/plan.ts";
import {
  audioSourceState,
  buildAudioSourceMap,
  resolveAudioSrc,
} from "../src/audio/sources.ts";
import {storyAudioDurations} from "../src/audio/storyAudio.ts";
import {compileTimeline} from "../src/story/timeline.ts";

const LOCAL = `local:audio:sha256:${"d".repeat(64)}`;
const OTHER_LOCAL = `local:audio:sha256:${"e".repeat(64)}`;
const POLICIES = ["explicit", "static-fallback"];

describe("resolveAudioSrc", () => {
  const entries = [
    [{kind: "url", url: "blob:http://x/a"}, {kind: "audio", src: "blob:http://x/a"}],
    [
      {kind: "static", path: "__local-assets/a.wav"},
      {kind: "audio", src: staticFile("__local-assets/a.wav")},
    ],
    [{kind: "pending"}, "pending"],
    [{kind: "unavailable"}, "missing"],
  ];

  for (const policy of POLICIES) {
    for (const [ref, label] of [
      [LOCAL, "local"],
      ["ding", "bundled"],
    ]) {
      for (const [entry, expected] of entries) {
        it(`${label} ref with a ${entry.kind} entry under ${policy}`, () => {
          const want =
            typeof expected === "string" ? {kind: expected, ref} : expected;

          assert.deepEqual(resolveAudioSrc(ref, {[ref]: entry}, policy), want);
        });
      }
    }
  }

  it("treats a local ref without an entry as missing under both policies", () => {
    for (const policy of POLICIES) {
      assert.deepEqual(resolveAudioSrc(LOCAL, undefined, policy), {
        kind: "missing",
        ref: LOCAL,
      });
      assert.deepEqual(
        resolveAudioSrc(LOCAL, {[OTHER_LOCAL]: {kind: "url", url: "blob:o"}}, policy),
        {kind: "missing", ref: LOCAL},
      );
    }
  });

  it("treats a bundled id without an entry as pending under explicit", () => {
    assert.deepEqual(resolveAudioSrc("ding", undefined, "explicit"), {
      kind: "pending",
      ref: "ding",
    });
    assert.deepEqual(resolveAudioSrc("ding", {}, "explicit"), {
      kind: "pending",
      ref: "ding",
    });
  });

  it("resolves a bundled id without an entry to its static file under static-fallback", () => {
    assert.deepEqual(resolveAudioSrc("ding", undefined, "static-fallback"), {
      kind: "audio",
      src: staticFile(bundledAudioCatalog.ding.file),
    });
    assert.equal(
      resolveAudioSrc("pop", {}, "static-fallback").src,
      staticFile("audio/sfx/pop.wav"),
    );
  });

  it("never falls back to another sound for bundled music without a file", () => {
    for (const id of ["calm-loop", "upbeat-loop"]) {
      assert.deepEqual(resolveAudioSrc(id, undefined, "static-fallback"), {
        kind: "missing",
        ref: id,
      });
      assert.deepEqual(resolveAudioSrc(id, undefined, "explicit"), {
        kind: "pending",
        ref: id,
      });
    }
  });

  it("lets an entry win over the static fallback", () => {
    assert.deepEqual(
      resolveAudioSrc("ding", {ding: {kind: "unavailable"}}, "static-fallback"),
      {kind: "missing", ref: "ding"},
    );
  });

  it("treats an entry with an unknown kind as missing, never as the bundled fallback", () => {
    for (const policy of POLICIES) {
      for (const ref of [LOCAL, "ding"]) {
        assert.deepEqual(
          resolveAudioSrc(ref, {[ref]: {kind: "bogus"}}, policy),
          {kind: "missing", ref},
        );
      }
    }
  });

  it("does not read prototype keys as entries", () => {
    const inherited = Object.create({[LOCAL]: {kind: "url", url: "blob:inherited"}});

    assert.equal(resolveAudioSrc(LOCAL, inherited, "explicit").kind, "missing");
  });
});

describe("audioSourceState", () => {
  it("maps resolutions to the planner's source states", () => {
    assert.equal(audioSourceState({kind: "audio", src: "x"}), "ready");
    assert.equal(audioSourceState({kind: "pending", ref: "ding"}), "pending");
    assert.equal(audioSourceState({kind: "missing", ref: "ding"}), "missing");
  });
});

describe("sources feed the audio plan", () => {
  const story = {
    title: "Sources",
    scenes: [
      {
        type: "dialogue",
        pose: "formal",
        background: "office",
        text: "Hi",
        duration: 4,
        sfx: {src: "ding"},
        voice: {src: LOCAL},
      },
    ],
  };
  const planWith = (sources, localDurations = {[LOCAL]: 2.2}) => {
    const durations = storyAudioDurations(story, localDurations);

    return compileAudioPlan({
      story,
      timeline: compileTimeline(story, 30, durations),
      fps: 30,
      audioDurations: durations,
      sourceState: (ref) =>
        audioSourceState(resolveAudioSrc(ref, sources, "explicit")),
    });
  };
  const ready = {
    ding: {kind: "url", url: "blob:ding"},
    [LOCAL]: {kind: "url", url: "blob:voice"},
  };

  it("plays everything when both sources are ready", () => {
    const plan = planWith(ready);

    assert.deepEqual(
      plan.tracks.map((track) => [track.key, track.durationInFrames]),
      [
        ["sfx-0", 36],
        ["voice-0", 66],
      ],
    );
    assert.deepEqual(plan.issues, []);
  });

  it("omits an unavailable bundled sound with one missing-audio issue and keeps the voice", () => {
    const plan = planWith({...ready, ding: {kind: "unavailable"}});

    assert.deepEqual(plan.tracks.map((track) => track.key), ["voice-0"]);
    assert.deepEqual(plan.issues, [
      {kind: "missing-audio", ref: "ding", role: "sfx", sceneIndex: 0},
    ]);
  });

  it("omits a pending bundled sound with pending-audio, never missing-audio", () => {
    const plan = planWith({...ready, ding: {kind: "pending"}});

    assert.deepEqual(plan.tracks.map((track) => track.key), ["voice-0"]);
    assert.deepEqual(plan.issues, [
      {kind: "pending-audio", ref: "ding", role: "sfx", sceneIndex: 0},
    ]);
  });

  it("reports pending-audio for a ready local ref whose duration is not in the map yet", () => {
    const plan = planWith(ready, {});

    assert.deepEqual(plan.tracks.map((track) => track.key), ["sfx-0"]);
    assert.deepEqual(plan.issues, [
      {kind: "pending-audio", ref: LOCAL, role: "voice", sceneIndex: 0},
    ]);
  });

  it("treats a bundled id with no entry as pending under the Player's explicit policy", () => {
    const plan = planWith({[LOCAL]: ready[LOCAL]});

    assert.deepEqual(plan.issues, [
      {kind: "pending-audio", ref: "ding", role: "sfx", sceneIndex: 0},
    ]);
  });
});

describe("buildAudioSourceMap", () => {
  const story = {
    title: "Map",
    music: {src: "calm-loop"},
    scenes: [
      {
        type: "dialogue",
        pose: "formal",
        background: "office",
        text: "Hi",
        duration: 3,
        sfx: {src: "ding"},
        voice: {src: LOCAL},
      },
    ],
  };

  it("copies the identical local entry object and the bundled entry", () => {
    const localEntry = {kind: "url", url: "blob:voice"};
    const bundledEntry = {kind: "url", url: "blob:ding"};
    const map = buildAudioSourceMap(
      story,
      {[LOCAL]: localEntry},
      (id) => (id === "ding" ? bundledEntry : undefined),
    );

    assert.equal(map[LOCAL], localEntry);
    assert.equal(map.ding, bundledEntry);
    assert.deepEqual(Object.keys(map).sort(), ["ding", LOCAL].sort());
  });

  it("keeps a pending local entry pending", () => {
    const pending = {kind: "pending"};
    const map = buildAudioSourceMap(story, {[LOCAL]: pending}, () => undefined);

    assert.equal(map[LOCAL], pending);
  });

  it("excludes refs the Story does not use, even when the producer has them", () => {
    const map = buildAudioSourceMap(
      story,
      {
        [LOCAL]: {kind: "url", url: "blob:voice"},
        [OTHER_LOCAL]: {kind: "url", url: "blob:other"},
      },
      (id) => ({kind: "url", url: `blob:${id}`}),
    );

    assert.equal(OTHER_LOCAL in map, false);
    assert.equal("pop" in map, false);
    assert.deepEqual(Object.keys(map).sort(), ["calm-loop", "ding", LOCAL].sort());
  });

  it("leaves a ref without an entry absent and ignores inherited entries", () => {
    const map = buildAudioSourceMap(
      story,
      Object.create({[LOCAL]: {kind: "url", url: "blob:inherited"}}),
      () => undefined,
    );

    assert.deepEqual(map, {});
    assert.deepEqual(buildAudioSourceMap(story, undefined, () => undefined), {});
  });

  it("never creates or revokes an object URL", () => {
    const create = mock.method(URL, "createObjectURL", () => "blob:spy");
    const revoke = mock.method(URL, "revokeObjectURL", () => undefined);

    try {
      buildAudioSourceMap(
        story,
        {[LOCAL]: {kind: "url", url: "blob:voice"}},
        () => ({kind: "url", url: "blob:ding"}),
      );
      assert.equal(create.mock.callCount(), 0);
      assert.equal(revoke.mock.callCount(), 0);
    } finally {
      create.mock.restore();
      revoke.mock.restore();
    }
  });

  it("is empty for a Story without audio", () => {
    assert.deepEqual(
      buildAudioSourceMap(
        {title: "T", scenes: [story.scenes[0]].map(({sfx, voice, ...rest}) => rest)},
        {[LOCAL]: {kind: "url", url: "blob:x"}},
        () => ({kind: "url", url: "blob:y"}),
      ),
      {},
    );
  });
});
