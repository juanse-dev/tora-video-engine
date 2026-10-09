import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {exampleStory} from "../src/story/exampleStory.ts";
import {
  PERSISTENCE_VERSION,
  PERSISTENCE_VERSION_LOCAL,
  requiredPersistenceVersion,
  restorePersistedProject,
  serializePersistedEnvelope,
} from "../src/web/persistence.ts";

const digest = "a".repeat(64);
const poseRef = `local:pose:sha256:${digest}`;
const backgroundRef = `local:background:sha256:${digest}`;

const bundledStory = structuredClone(exampleStory);
const localStory = structuredClone(exampleStory);
localStory.scenes[0] = {...localStory.scenes[0], pose: poseRef};
const localBackgroundStory = structuredClone(exampleStory);
localBackgroundStory.scenes[1] = {
  ...localBackgroundStory.scenes[1],
  background: backgroundRef,
};

const fallback = structuredClone(exampleStory);

describe("ASSET-001 persistence envelope v1/v2", () => {
  it("exports the version constants", () => {
    assert.equal(PERSISTENCE_VERSION, 1);
    assert.equal(PERSISTENCE_VERSION_LOCAL, 2);
  });

  it("restores a v1 bundled envelope with durableVersion 1", () => {
    const result = restorePersistedProject(
      JSON.stringify({version: 1, story: bundledStory}),
      fallback,
    );

    assert.equal(result.restored, true);
    assert.equal(result.recovery, null);
    assert.equal(result.durableVersion, 1);
    assert.deepEqual(result.durableStory, bundledStory);
  });

  it("restores a v2 envelope with local refs with durableVersion 2", () => {
    for (const story of [localStory, localBackgroundStory]) {
      const result = restorePersistedProject(
        JSON.stringify({version: 2, story}),
        fallback,
      );

      assert.equal(result.restored, true);
      assert.equal(result.recovery, null);
      assert.equal(result.durableVersion, 2);
      assert.deepEqual(result.durableStory, story);
    }
  });

  it("restores a v2 envelope with a bundled-only story with durableVersion 2", () => {
    const result = restorePersistedProject(
      JSON.stringify({version: 2, story: bundledStory}),
      fallback,
    );

    assert.equal(result.restored, true);
    assert.equal(result.durableVersion, 2);
  });

  it("reports durableVersion null when nothing was restored", () => {
    const empty = restorePersistedProject(null, fallback);
    assert.equal(empty.durableVersion, null);

    const malformed = restorePersistedProject("{not json", fallback);
    assert.equal(malformed.durableVersion, null);

    const unsupported = restorePersistedProject(
      JSON.stringify({version: 3, story: bundledStory}),
      fallback,
    );
    assert.equal(unsupported.durableVersion, null);
  });

  it("treats a v1 envelope containing a local ref as schema-invalid recovery", () => {
    for (const story of [localStory, localBackgroundStory]) {
      const raw = JSON.stringify({version: 1, story});
      const result = restorePersistedProject(raw, fallback);

      assert.equal(result.restored, false);
      assert.equal(result.durableStory, null);
      assert.equal(result.durableVersion, null);
      assert.equal(result.recovery?.kind, "raw");
      assert.equal(result.recovery?.reason, "schema-invalid");
      assert.equal(
        result.recovery?.message,
        "Stored project version 1 cannot contain local asset references.",
      );
      assert.equal(result.recovery?.raw, raw);
    }
  });

  it("treats version 3 as unsupported-version recovery", () => {
    const raw = JSON.stringify({version: 3, story: bundledStory});
    const result = restorePersistedProject(raw, fallback);

    assert.equal(result.restored, false);
    assert.equal(result.recovery?.kind, "raw");
    assert.equal(result.recovery?.reason, "unsupported-version");
    assert.equal(result.durableVersion, null);
  });

  it("computes the required version as max(durableVersion ?? 1, local ? 2 : 1)", () => {
    assert.equal(requiredPersistenceVersion(bundledStory, null), 1);
    assert.equal(requiredPersistenceVersion(bundledStory, 1), 1);
    assert.equal(requiredPersistenceVersion(bundledStory, 2), 2);
    assert.equal(requiredPersistenceVersion(localStory, null), 2);
    assert.equal(requiredPersistenceVersion(localStory, 1), 2);
    assert.equal(requiredPersistenceVersion(localStory, 2), 2);
    assert.equal(requiredPersistenceVersion(localBackgroundStory, 1), 2);
  });

  it("serializes v1 for bundled stories, v2 for local refs, and never downgrades", () => {
    const versionOf = (story, durableVersion) =>
      JSON.parse(
        serializePersistedEnvelope(
          story,
          requiredPersistenceVersion(story, durableVersion),
        ),
      ).version;

    assert.equal(versionOf(bundledStory, 1), 1);
    assert.equal(versionOf(localStory, 1), 2);
    assert.equal(versionOf(bundledStory, 2), 2);
    assert.equal(versionOf(localStory, 2), 2);
  });

  it("round-trips a serialized v2 envelope", () => {
    const raw = serializePersistedEnvelope(localStory, 2);
    const result = restorePersistedProject(raw, fallback);

    assert.equal(result.restored, true);
    assert.equal(result.durableVersion, 2);
    assert.deepEqual(result.durableStory, localStory);
  });

  it("keeps serializePersistedEnvelope(story) backward compatible as v1", () => {
    const serialized = serializePersistedEnvelope(bundledStory);

    assert.equal(typeof serialized, "string");
    assert.equal(JSON.parse(serialized).version, 1);
    assert.equal(restorePersistedProject(serialized, fallback).durableVersion, 1);
  });

  it("documents v0.2 rollback: a version !== 1 reader rejects a v2 envelope", () => {
    const v02Reader = (raw) => {
      const envelope = JSON.parse(raw);
      return envelope.version !== 1 ? "unsupported-version" : "ok";
    };

    assert.equal(
      v02Reader(serializePersistedEnvelope(localStory, 2)),
      "unsupported-version",
    );
    assert.equal(v02Reader(serializePersistedEnvelope(bundledStory)), "ok");
  });
});
