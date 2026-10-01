import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {exampleStory} from "../src/story/exampleStory.ts";
import {parseStorySource} from "../src/story/parseStory.ts";
import {serializeStorySource} from "../src/story/serializeStory.ts";
import {
  getDownloadBasename,
  getYamlDownloadFilename,
} from "../src/web/downloads.ts";
import {
  MAX_PERSISTED_ENVELOPE_CODE_UNITS,
  PERSISTENCE_VERSION,
  acquirePersistenceOwnership,
  restorePersistedProject,
  serializePersistedEnvelope,
} from "../src/web/persistence.ts";
import {
  MAX_BROWSER_YAML_SOURCE_CODE_UNITS,
  applyYamlState,
  canExportYamlCandidate,
  createYamlStateFromActiveStory,
  createYamlStateFromTransferredCandidate,
  evaluateYamlSource,
  isYamlDirty,
  tryEditYamlBuffer,
  validateYamlBuffer,
} from "../src/web/yamlState.ts";

describe("WEB-005 YAML state", () => {
  it("round-trips canonical Story YAML semantically", () => {
    const source = serializeStorySource(exampleStory);
    assert.deepEqual(parseStorySource(source), exampleStory);
  });

  it("rejects oversized pasted text before TextEncoder or parser", () => {
    const state = createYamlStateFromActiveStory(exampleStory);
    let encoded = 0;
    let parsed = 0;

    const result = tryEditYamlBuffer(
      state,
      "a".repeat(MAX_BROWSER_YAML_SOURCE_CODE_UNITS + 1),
    );

    assert.equal(result.accepted, false);
    assert.equal(result.state.buffer, state.buffer);
    assert.equal(encoded, 0);
    assert.equal(parsed, 0);
  });

  it("checks exact UTF-8 overflow only in validation and before parser", () => {
    const state = createYamlStateFromActiveStory(exampleStory);
    let encoded = 0;
    let parsed = 0;

    const edited = tryEditYamlBuffer(state, "é");

    assert.equal(edited.accepted, true);
    assert.equal(edited.state.validation.kind, "pending");
    assert.equal(encoded, 0);
    assert.equal(parsed, 0);

    const validated = validateYamlBuffer(edited.state, "editor.yaml", {
      utf8ByteLength: () => {
        encoded += 1;
        return 1_048_577;
      },
      parse: () => {
        parsed += 1;
        return exampleStory;
      },
    });

    assert.equal(encoded, 1);
    assert.equal(parsed, 0);
    assert.equal(validated.validation.kind, "source-oversized");
  });

  it("makes noncanonical applied YAML clean at the exact buffer", () => {
    const initial = createYamlStateFromActiveStory(exampleStory);
    const noncanonical = serializeStorySource(exampleStory)
      .replace("title: Deploy Friday", "title: 'Deploy Friday'");

    const edited = tryEditYamlBuffer(initial, noncanonical);
    assert.equal(edited.accepted, true);
    assert.equal(isYamlDirty(edited.state), true);

    const validated = validateYamlBuffer(edited.state);
    const applied = applyYamlState(validated);
    assert.equal(applied.applied, true);
    assert.equal(applied.state.baseline, noncanonical);
    assert.equal(applied.state.buffer, noncanonical);
    assert.equal(isYamlDirty(applied.state), false);

    const changed = tryEditYamlBuffer(
      applied.state,
      noncanonical + "\n# later edit\n",
    );
    assert.equal(changed.accepted, true);
    assert.equal(isYamlDirty(changed.state), true);
  });

  it("keeps invalid YAML away from the active Story contract", () => {
    const state = createYamlStateFromActiveStory(exampleStory);
    const edited = tryEditYamlBuffer(state, "title: [broken");

    assert.equal(edited.accepted, true);
    assert.equal(edited.state.validation.kind, "pending");

    const validated = validateYamlBuffer(edited.state);
    assert.equal(validated.validation.kind, "parse-invalid");
    assert.equal(applyYamlState(validated).applied, false);
  });

  it("keeps policy-rejected YAML distinct and exportable", () => {
    const overBudget = structuredClone(exampleStory);
    overBudget.scenes[0].duration = 301;
    const source = serializeStorySource(overBudget);
    const validation = evaluateYamlSource(source);

    assert.equal(validation.kind, "policy-rejected");

    const initial = createYamlStateFromActiveStory(exampleStory);
    const edited = tryEditYamlBuffer(initial, source);

    assert.equal(edited.accepted, true);
    assert.equal(edited.state.validation.kind, "pending");
    assert.equal(canExportYamlCandidate(edited.state), false);

    const validated = validateYamlBuffer(edited.state);
    assert.equal(validated.validation.kind, "policy-rejected");
    assert.equal(canExportYamlCandidate(validated), true);
    assert.equal(applyYamlState(validated).applied, false);
  });

  it("transfers exact validated visual candidate with a fresh active baseline", () => {
    const active = structuredClone(exampleStory);
    const candidate = structuredClone(exampleStory);
    candidate.scenes[0].duration = 301;

    const state = createYamlStateFromTransferredCandidate(active, candidate);

    assert.equal(state.baseline, serializeStorySource(active));
    assert.equal(state.buffer, serializeStorySource(candidate));
    assert.equal(isYamlDirty(state), true);
    assert.equal(state.transferSnapshot.story, candidate);

    const edited = tryEditYamlBuffer(state, state.buffer + "\n");
    assert.equal(edited.accepted, true);
    assert.equal(edited.state.transferSnapshot, null);
  });
});

describe("WEB-005 download basename", () => {
  const cases = [
    ["a/b\\c<d>e:f\"g|h?i*j", "a-b-c-d-e-f-g-h-i-j"],
    ["  ...hello...  ", "hello"],
    ["CON", "tora-CON"],
    ["con.txt", "tora-con.txt"],
    ["COM¹", "tora-COM¹"],
    ["COM².log", "tora-COM².log"],
    ["LPT³", "tora-LPT³"],
    ["áé漢字", "áé漢字"],
    ["hello   world", "hello-world"],
    ["\u0000\u0007name", "name"],
    ["   ... ---   ", "tora-video"],
  ];

  for (const [title, expected] of cases) {
    it(`sanitizes ${JSON.stringify(title)} deterministically`, () => {
      const first = getDownloadBasename(title);
      const second = getDownloadBasename(title);

      assert.equal(first, expected);
      assert.equal(second, expected);
      assert.ok(new TextEncoder().encode(first).byteLength <= 96);
    });
  }

  it("preserves emoji without splitting a code point at 96 bytes", () => {
    const basename = getDownloadBasename("😀".repeat(40));
    const bytes = new TextEncoder().encode(basename);

    assert.ok(bytes.byteLength <= 96);
    assert.equal(Array.from(basename).length, 24);
    assert.equal(basename, "😀".repeat(24));
  });

  it("rechecks reserved Windows names after truncation and edge trimming", () => {
    const title = "CON" + "-.".repeat(47) + "x";
    const basename = getDownloadBasename(title);

    assert.equal(basename, "tora-CON");
    assert.ok(new TextEncoder().encode(basename).byteLength <= 96);
  });

  it("stays bounded for a 65,536-code-unit title", () => {
    const basename = getDownloadBasename("a".repeat(65_536));
    assert.equal(new TextEncoder().encode(basename).byteLength, 96);
    assert.equal(getYamlDownloadFilename("CON"), "tora-CON.yaml");
  });
});

describe("WEB-005 persisted restore pipeline", () => {
  it("keeps a maximum browser-shape envelope within the storage bound", () => {
    const story = {
      title: "T".repeat(65_536),
      scenes: Array.from({length: 200}, () => ({
        type: "intro",
        pose: "formal",
        background: "office",
        text: "A".repeat(180),
        duration: 1,
      })),
    };

    const serialized = serializePersistedEnvelope(story);
    assert.ok(serialized.length <= MAX_PERSISTED_ENVELOPE_CODE_UNITS);
  });

  it("quarantines oversized raw storage before JSON.parse", () => {
    let parsed = 0;
    const raw = "x".repeat(MAX_PERSISTED_ENVELOPE_CODE_UNITS + 1);
    const result = restorePersistedProject(raw, exampleStory, {
      jsonParse: () => {
        parsed += 1;
        return {};
      },
    });

    assert.equal(parsed, 0);
    assert.equal(result.recovery.kind, "raw");
    assert.equal(result.recovery.reason, "oversized");
    assert.equal(result.recovery.raw, raw);
    assert.equal(result.activeStory, exampleStory);
  });

  it("preserves malformed raw storage exactly", () => {
    const raw = "{not-json";
    const result = restorePersistedProject(raw, exampleStory);

    assert.equal(result.recovery.kind, "raw");
    assert.equal(result.recovery.reason, "malformed");
    assert.equal(result.recovery.raw, raw);
  });

  it("rejects unsupported versions before StorySchema", () => {
    let storyParseCalls = 0;
    const raw = JSON.stringify({
      version: 999,
      story: exampleStory,
    });
    const result = restorePersistedProject(raw, exampleStory, {
      storyParse: () => {
        storyParseCalls += 1;
        return {success: true, data: exampleStory};
      },
    });

    assert.equal(storyParseCalls, 0);
    assert.equal(result.recovery.reason, "unsupported-version");
  });

  it("preflights oversized title before StorySchema", () => {
    let storyParseCalls = 0;
    const raw = JSON.stringify({
      version: PERSISTENCE_VERSION,
      story: {
        ...exampleStory,
        title: "a".repeat(65_537),
      },
    });
    const result = restorePersistedProject(raw, exampleStory, {
      storyParse: () => {
        storyParseCalls += 1;
        return {success: true, data: exampleStory};
      },
    });

    assert.equal(storyParseCalls, 0);
    assert.equal(result.recovery.reason, "preflight-rejected");
    assert.equal(result.recovery.raw, raw);
  });

  it("preflights scene count before StorySchema", () => {
    let storyParseCalls = 0;
    const raw = JSON.stringify({
      version: PERSISTENCE_VERSION,
      story: {
        ...exampleStory,
        scenes: Array.from(
          {length: 201},
          () => structuredClone(exampleStory.scenes[0]),
        ),
      },
    });
    const result = restorePersistedProject(raw, exampleStory, {
      storyParse: () => {
        storyParseCalls += 1;
        return {success: true, data: exampleStory};
      },
    });

    assert.equal(storyParseCalls, 0);
    assert.equal(result.recovery.reason, "preflight-rejected");
    assert.equal(result.recovery.raw, raw);
  });

  it("preflights raw caption length before StorySchema/font coverage", () => {
    let storyParseCalls = 0;
    const raw = JSON.stringify({
      version: PERSISTENCE_VERSION,
      story: {
        ...exampleStory,
        scenes: [
          {
            ...exampleStory.scenes[0],
            text: "a".repeat(361),
          },
        ],
      },
    });
    const result = restorePersistedProject(raw, exampleStory, {
      storyParse: () => {
        storyParseCalls += 1;
        return {success: true, data: exampleStory};
      },
    });

    assert.equal(storyParseCalls, 0);
    assert.equal(result.recovery.reason, "preflight-rejected");
    assert.equal(result.recovery.raw, raw);
  });

  it("protects schema-invalid raw storage", () => {
    const raw = JSON.stringify({
      version: PERSISTENCE_VERSION,
      story: {...exampleStory, scenes: []},
    });
    const result = restorePersistedProject(raw, exampleStory);

    assert.equal(result.recovery.kind, "raw");
    assert.equal(result.recovery.reason, "schema-invalid");
    assert.equal(result.recovery.raw, raw);
  });

  it("retains schema-valid policy-rejected storage as validated recovery", () => {
    const story = structuredClone(exampleStory);
    story.scenes[0].duration = 301;
    const raw = JSON.stringify({version: PERSISTENCE_VERSION, story});
    const result = restorePersistedProject(raw, exampleStory);

    assert.equal(result.recovery.kind, "policy-rejected");
    assert.deepEqual(result.recovery.story, story);
    assert.equal(result.activeStory, exampleStory);
  });

  it("restores eligible storage after all guards", () => {
    const story = structuredClone(exampleStory);
    story.title = "Restored";
    const raw = serializePersistedEnvelope(story);
    const result = restorePersistedProject(raw, exampleStory);

    assert.equal(result.restored, true);
    assert.deepEqual(result.activeStory, story);
    assert.deepEqual(result.durableStory, story);
    assert.equal(result.recovery, null);
  });
});

describe("WEB-005 persistence writer lock", () => {
  it("enters session-only mode when Web Locks is unavailable", async () => {
    assert.deepEqual(
      await acquirePersistenceOwnership(undefined),
      {mode: "session-only"},
    );
  });

  it("becomes secondary when the stable lock is unavailable", async () => {
    const locks = {
      request: async (_name, options, callback) => {
        assert.equal(options.ifAvailable, true);
        assert.equal(options.mode, "exclusive");
        return callback(null);
      },
    };

    assert.deepEqual(
      await acquirePersistenceOwnership(locks),
      {mode: "secondary"},
    );
  });


  it("degrades to session-only when Web Locks request fails", async () => {
    const locks = {
      request: async () => {
        throw new Error("locks unavailable");
      },
    };

    assert.deepEqual(
      await acquirePersistenceOwnership(locks),
      {mode: "session-only"},
    );
  });
});
