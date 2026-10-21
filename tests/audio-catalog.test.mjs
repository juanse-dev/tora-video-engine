import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  autoDurationMinFrames,
  AUTO_DURATION_PADDING_SECONDS,
} from "../src/audio/constants.ts";
import {
  buildAudioDurationMap,
  bundledAudioCatalog,
  bundledAudioIds,
  isAudioRef,
  isBundledAudio,
} from "../src/audio/catalog.ts";

const local = `local:audio:sha256:${"a".repeat(64)}`;

describe("bundled audio catalog", () => {
  it("has the six ids in order, each entry keyed by its id", () => {
    assert.deepEqual([...bundledAudioIds], ["whoosh", "boom", "ding", "pop", "calm-loop", "upbeat-loop"]);
    for (const id of bundledAudioIds) assert.equal(bundledAudioCatalog[id].id, id);
  });

  it("keeps music unsupplied (file and duration null together)", () => {
    for (const id of ["calm-loop", "upbeat-loop"]) {
      assert.equal(bundledAudioCatalog[id].kind, "music");
      assert.equal(bundledAudioCatalog[id].file, null);
      assert.equal(bundledAudioCatalog[id].durationSeconds, null);
    }
    for (const entry of Object.values(bundledAudioCatalog)) {
      assert.equal(entry.file === null, entry.durationSeconds === null, entry.id);
    }
  });

  it("recognises bundled and local audio refs only", () => {
    assert.equal(isBundledAudio("boom"), true);
    assert.equal(isBundledAudio("office"), false);
    assert.equal(isAudioRef(local), true);
    assert.equal(isAudioRef(`local:pose:sha256:${"a".repeat(64)}`), false);
  });

  it("builds a duration map from local durations plus non-null bundled ones", () => {
    const map = buildAudioDurationMap(["boom", "calm-loop", local], {[local]: 2.2});
    assert.equal(map[local], 2.2);
    assert.equal(map.boom, 3.2);
    assert.equal("calm-loop" in map, false);
  });

  it("drops local durations that are not finite and greater than 0", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, -0.001]) {
      const map = buildAudioDurationMap([local], {[local]: bad});

      assert.equal(local in map, false, String(bad));
    }

    assert.equal(buildAudioDurationMap([local], {[local]: 0.005})[local], 0.005);
  });

  it("derives the auto lower bound from the padding", () => {
    assert.equal(AUTO_DURATION_PADDING_SECONDS, 0.5);
    assert.equal(autoDurationMinFrames(30), 16);
  });
});
