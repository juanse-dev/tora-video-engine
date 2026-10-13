import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {exampleStory} from "../src/story/exampleStory.ts";
import {
  PERSISTENCE_VERSION_AUDIO,
  requiredPersistenceVersion,
  restorePersistedProject,
  serializePersistedEnvelope,
} from "../src/web/persistence.ts";

const local = `local:pose:sha256:${"a".repeat(64)}`;
const bundled = structuredClone(exampleStory);
const withLocal = structuredClone(exampleStory); withLocal.scenes[0].pose = local;
const withAudio = {...structuredClone(exampleStory), music: {src: "boom"}};
const withBoth = {...structuredClone(withLocal), music: {src: "boom"}};

describe("requiredPersistenceVersion", () => {
  const cases = [
    [bundled, null, 1], [withLocal, null, 2], [withAudio, null, 3], [withBoth, null, 3],
    [withLocal, 1, 2], [withAudio, 1, 3], [withAudio, 2, 3],
    [bundled, 2, 2], [bundled, 3, 3], [withLocal, 3, 3],
  ];
  for (const [story, durable, expected] of cases) {
    it(`durable ${durable} → ${expected}`, () => assert.equal(requiredPersistenceVersion(story, durable), expected));
  }
  it("exports version 3", () => assert.equal(PERSISTENCE_VERSION_AUDIO, 3));
});

describe("restore", () => {
  it("restores a v3 envelope with audio", () => {
    const r = restorePersistedProject(serializePersistedEnvelope(withAudio, 3), bundled);
    assert.equal(r.restored, true);
    assert.equal(r.durableVersion, 3);
    assert.deepEqual(r.activeStory.music, {src: "boom"});
  });
  for (const v of [1, 2]) {
    it(`rejects audio in a version ${v} envelope`, () => {
      const r = restorePersistedProject(JSON.stringify({version: v, story: withAudio}), bundled);
      assert.equal(r.restored, false);
      assert.equal(r.recovery.message, `Stored project version ${v} cannot contain audio.`);
      assert.equal(r.recovery.reason, "schema-invalid");
    });
  }
  it("a version 1 envelope with both local refs and audio reports the local-ref message first", () => {
    const r = restorePersistedProject(JSON.stringify({version: 1, story: withBoth}), bundled);
    assert.equal(r.restored, false);
    assert.equal(r.recovery.message, "Stored project version 1 cannot contain local asset references.");
  });
  it("restores a stored project with auto scenes before any duration is known", () => {
    const voice = `local:audio:sha256:${"b".repeat(64)}`;
    const story = structuredClone(exampleStory);
    story.scenes = Array.from({length: 101}, () => ({type: "intro", pose: "formal", background: "office", text: "x", voice: {src: voice}, duration: "auto"}));
    const r = restorePersistedProject(serializePersistedEnvelope(story, 3), bundled);
    assert.equal(r.restored, true);
  });
});

describe("a v0.3 reader", () => {
  // Frozen copy of main's version check before this task: accepts only 1 and 2.
  const v03Accepts = (version) => version === 1 || version === 2;
  it("treats a version 3 envelope as unsupported (and the app preserves it as raw recovery)", () => {
    const envelope = JSON.parse(serializePersistedEnvelope(withAudio, 3));
    assert.equal(v03Accepts(envelope.version), false);
  });
  it("keeps the raw text for an unsupported version 4 envelope", () => {
    const raw = JSON.stringify({version: 4, story: withAudio});
    const r = restorePersistedProject(raw, bundled);
    assert.equal(r.restored, false);
    assert.equal(r.recovery.kind, "raw");
    assert.equal(r.recovery.reason, "unsupported-version");
    assert.equal(r.recovery.raw, raw);
    assert.equal(r.durableVersion, null);
  });
});
