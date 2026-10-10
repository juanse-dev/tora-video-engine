import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {forbiddenInExportedYaml} from "./gate/helpers/exportedYaml.mjs";

const REF = `local:pose:sha256:${"a".repeat(64)}`;

describe("GATE-001 step 7 exported YAML checks", () => {
  it("accepts a Story with local refs, URLs in text and the word metadata", () => {
    const yaml = [
      "title: Deploy Friday",
      "scenes:",
      `  - pose: ${REF}`,
      '    text: "See https://example.com/a/b and metadata: none, profile: x"',
    ].join("\n");

    assert.deepEqual(forbiddenInExportedYaml(yaml), []);
  });

  it("flags each kind of leak", () => {
    const cases = {
      "a blob: URL": "pose: blob:https://x.example/abc",
      "a data: URL": "pose: data:image/png;base64,AAAA",
      "a file: URL": "pose: file:///tmp/x.png",
      "a backslash path": "pose: C:\\Users\\me\\x.png",
      "a Windows drive path": "pose: C:/Users/me/x.png",
      "a Unix home or temp path": "pose: /home/me/x.png",
      "a base64 run": `pose: ${"QUJD".repeat(40)}`,
    };

    for (const [label, yaml] of Object.entries(cases)) {
      assert.ok(
        forbiddenInExportedYaml(yaml).includes(label),
        `${label} in ${yaml}`,
      );
    }
  });

  it("flags forbidden names", () => {
    assert.deepEqual(forbiddenInExportedYaml("pose: pose-magenta", ["pose-magenta"]), [
      '"pose-magenta"',
    ]);
  });

  it("does not take a 64-hex digest for a base64 run", () => {
    assert.deepEqual(forbiddenInExportedYaml(`pose: ${REF}\nbackground: ${REF}`), []);
  });
});
