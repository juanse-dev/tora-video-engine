import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {summarizePlaywrightOutput} from "../scripts/gateSummary.mjs";

describe("GATE-001 summarizePlaywrightOutput", () => {
  it("returns the first failure block without colour codes", () => {
    const output = [
      "Running 1 test using 1 worker",
      "",
      "  1) tests/gate/x.spec.mjs:14:1 › phase A: records",
      "",
      "    \u001b[31mError: no meta\u001b[39m",
      "",
      "       at helpers/buildIdentity.mjs:46",
      "  1 failed",
    ].join("\n");
    const summary = summarizePlaywrightOutput(output, 3);

    assert.equal(
      summary,
      [
        "1) tests/gate/x.spec.mjs:14:1 › phase A: records",
        "Error: no meta",
        "at helpers/buildIdentity.mjs:46",
      ].join("\n"),
    );
  });

  it("falls back to the first error line when there is no numbered failure", () => {
    const output = "Gate: phase A\nError: http://127.0.0.1:4190/index.html is already used\nmore\n";

    assert.match(summarizePlaywrightOutput(output), /^Error: http:\/\/127\.0\.0\.1:4190\/index\.html is already used/);
  });

  it("falls back to the last lines, and to a note for empty output", () => {
    assert.equal(summarizePlaywrightOutput("a\nb\nc\nd", 2), "c\nd");
    assert.match(summarizePlaywrightOutput(""), /no output/);
  });
});
