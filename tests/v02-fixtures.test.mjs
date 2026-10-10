import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {parseStorySource} from "../src/story/parseStory.ts";
import {serializeStorySource} from "../src/story/serializeStory.ts";
import {serializePersistedEnvelope} from "../src/web/persistence.ts";

// The fixtures in tests/fixtures/v0.2 are real v0.2 output (commit 962e030, see
// the README there). The current serializers must still produce the same bytes
// for bundled-only Stories (ASSET-006 A2).

const read = (url) => readFile(new URL(url, import.meta.url), "utf8");

for (const name of ["friday-deploy", "ci-smoke", "demo-reel"]) {
  test(`serializeStorySource still writes the v0.2 YAML for stories/${name}.yaml`, async () => {
    const story = parseStorySource(
      await read(`../stories/${name}.yaml`),
      `${name}.yaml`,
    );

    assert.equal(
      serializeStorySource(story),
      await read(`./fixtures/v0.2/${name}.yaml`),
    );
  });
}

test("serializePersistedEnvelope still writes the v0.2 version 1 envelope for a bundled Story", async () => {
  const envelope = await read("./fixtures/v0.2/project-envelope.json");

  assert.equal(JSON.parse(envelope).version, 1);
  assert.equal(
    serializePersistedEnvelope(JSON.parse(envelope).story),
    envelope,
  );
});
