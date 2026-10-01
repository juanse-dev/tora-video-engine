import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {describe, it} from "node:test";
import {parseStorySource} from "../src/story/parseStory.ts";
import {serializeStorySource} from "../src/story/serializeStory.ts";

const canonicalPath = resolve("stories/friday-deploy.yaml");

const validScene = `title: Test
scenes:
  - type: intro
    pose: formal
    background: office
    text: Test
    duration: 1
`;

describe("browser-safe Story source boundary", () => {
  it("parses the canonical YAML without filesystem coupling", async () => {
    const source = await readFile(canonicalPath, "utf8");
    const story = parseStorySource(source, "friday-deploy.yaml");

    assert.equal(story.title, "Deploy Friday");
    assert.equal(story.scenes.length, 4);
  });

  it("reports malformed YAML with source context", () => {
    assert.throws(
      () =>
        parseStorySource(
          `title: Broken
scenes:
  - type: intro
    pose: [formal
`,
          "broken.yaml",
        ),
      /Failed to parse YAML "broken\.yaml"/,
    );
  });

  it("reports schema paths and source context", () => {
    assert.throws(
      () =>
        parseStorySource(
          `title: Test
scenes:
  - type: montage
    pose: formal
    background: office
    text: Test
    duration: 1
`,
          "invalid.yaml",
        ),
      /Invalid story "invalid\.yaml":[\s\S]*scenes\.0\.type/,
    );
  });

  it("rejects invalid durations before rendering", () => {
    assert.throws(
      () =>
        parseStorySource(`title: Test
scenes:
  - type: intro
    pose: formal
    background: office
    text: Test
    duration: 0
`),
      /scenes\.0\.duration/,
    );
  });

  it("rejects caption text unsupported by the bundled font", () => {
    assert.throws(
      () =>
        parseStorySource(`title: Test
scenes:
  - type: intro
    pose: formal
    background: office
    text: "Tora 😀"
    duration: 1
`),
      /scenes\.0\.text/,
    );
  });

  it("round-trips a validated Story through canonical YAML", async () => {
    const source = await readFile(canonicalPath, "utf8");
    const story = parseStorySource(source, "friday-deploy.yaml");
    const serialized = serializeStorySource(story);
    const reparsed = parseStorySource(serialized, "round-trip.yaml");

    assert.deepEqual(reparsed, story);
  });

  it("serializes the same Story deterministically", () => {
    const story = parseStorySource(validScene);

    assert.equal(
      serializeStorySource(story),
      serializeStorySource(structuredClone(story)),
    );
  });

  it("keeps the browser-safe local dependency graph free of node:* imports", async () => {
    const pending = [
      resolve("src/story/parseStory.ts"),
      resolve("src/story/serializeStory.ts"),
    ];
    const visited = new Set();

    while (pending.length > 0) {
      const path = pending.pop();

      if (path === undefined || visited.has(path)) {
        continue;
      }

      visited.add(path);
      const source = await readFile(path, "utf8");

      assert.doesNotMatch(
        source,
        /from\s+["']node:/,
        `${path} must remain browser-safe`,
      );

      for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const specifier = match[1];

        if (specifier.endsWith(".ts")) {
          pending.push(resolve(dirname(path), specifier));
        }
      }
    }
  });

  it("keeps loadStory as a thin Node filesystem adapter", async () => {
    const source = await readFile(resolve("src/story/loadStory.ts"), "utf8");

    assert.match(source, /parseStorySource/);
    assert.doesNotMatch(source, /from\s+["']yaml["']/);
    assert.doesNotMatch(source, /StorySchema/);
  });
});
