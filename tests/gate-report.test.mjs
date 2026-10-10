import assert from "node:assert/strict";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "node:test";
import {
  GOLDEN_ITEMS,
  RECORD_ROWS,
  renderReport,
  writeReport,
} from "./gate/helpers/report.mjs";
import {
  mergePhase,
  recordResult,
  startPhaseA,
  statePaths,
  targetDir,
} from "./gate/helpers/gateState.mjs";

const POSE =
  "local:pose:sha256:e572d1a4c4908ab8ee783693c99a050b45a28fa030e48e645b64e354651a0ca7";
const BACKGROUND =
  "local:background:sha256:3470d1d2f387e4e55b88e8139f84bde89dc8a9b015827ec638ecf5af9a8fdc06";

const phaseAState = () => ({
  version: 1,
  target: "prod",
  url: "https://tora-video-engine.netlify.app",
  a: {
    startedAt: "2026-10-10T10:00:00.000Z",
    finishedAt: "2026-10-10T10:05:00.000Z",
    identity: {commit: "d4aa69a", deployId: "6ac9d19a", context: "production"},
    browser: {name: "Chrome", version: "154.0.8037.98"},
    refs: {pose: POSE, background: BACKGROUND},
  },
  results: {
    reload: {status: "pending", detail: "Phase A steps 2-6 pass.", phase: "A"},
    noUpload: {status: "pending", detail: "Phase A clean.", phase: "A"},
    cliParity: {status: "pass", detail: "360 frames, same colours.", phase: "A"},
    ...Object.fromEntries(
      GOLDEN_ITEMS.map(({key}) => [key, {status: "pass", detail: "", phase: "A"}]),
    ),
  },
  netlify: {},
});

const fullState = () => {
  const state = phaseAState();

  state.b = {
    startedAt: "2026-10-10T12:00:00.000Z",
    finishedAt: "2026-10-10T12:03:00.000Z",
    identity: {commit: "da946d8", deployId: "6aca4836", context: "production"},
    browser: {name: "Chrome", version: "154.0.8037.98"},
  };
  state.results.reload = {status: "pass", detail: "Reload, restart and A to B pass.", phase: "B"};
  state.results.noUpload = {status: "pass", detail: "Only POST: register-usage-point (0.2 kB).", phase: "B"};
  state.results.deleteReimport = {status: "pass", detail: "Delete warned; re-import resolved.", phase: "B"};
  state.netlify = {
    A: {status: "pass", detail: "ready, commit matches, published; Functions: none"},
    B: {status: "pass", detail: "ready, commit matches, published; Functions: none"},
  };

  return state;
};

const GOLDEN_A = GOLDEN_ITEMS.map(({label}) => `- [x] ${label}`).join("\n");

const PHASE_A_REPORT = `# Tora deployed verification: prod

Result: PHASE A PASSED (phase B pending)

- URL: https://tora-video-engine.netlify.app
- Phase A: 2026-10-10T10:00:00.000Z to 2026-10-10T10:05:00.000Z
- Phase B: pending

## ASSET-006 Part B Record

| Item | Value |
| --- | --- |
| Production URL | \`https://tora-video-engine.netlify.app\` |
| Deploy A (commit / Netlify ID) | \`d4aa69a\` / \`6ac9d19a\` (production) |
| Deploy B (commit / Netlify ID) | pending phase B |
| Browser + version, profile | Chrome 154.0.8037.98; gate profile \`.gate/prod/profile\` (dedicated, created fresh by phase A) |
| Fixture refs | \`${POSE}\`, \`${BACKGROUND}\` |
| Reload / restart / A → B results | Pending. Phase A steps 2-6 pass. |
| Delete → re-import recovery | pending phase B |
| No-upload check | Pending. Phase A clean. |
| CLI parity | Pass. 360 frames, same colours. |

## WEB-007 golden checklist

${GOLDEN_A}

## Netlify check

Netlify check: manual (no token)

## Failures

None.
`;

const FULL_REPORT = `# Tora deployed verification: prod

Result: PASS

- URL: https://tora-video-engine.netlify.app
- Phase A: 2026-10-10T10:00:00.000Z to 2026-10-10T10:05:00.000Z
- Phase B: 2026-10-10T12:00:00.000Z to 2026-10-10T12:03:00.000Z

## ASSET-006 Part B Record

| Item | Value |
| --- | --- |
| Production URL | \`https://tora-video-engine.netlify.app\` |
| Deploy A (commit / Netlify ID) | \`d4aa69a\` / \`6ac9d19a\` (production) |
| Deploy B (commit / Netlify ID) | \`da946d8\` / \`6aca4836\` (production) |
| Browser + version, profile | Chrome 154.0.8037.98; gate profile \`.gate/prod/profile\` (dedicated, created fresh by phase A) |
| Fixture refs | \`${POSE}\`, \`${BACKGROUND}\` |
| Reload / restart / A → B results | Pass. Reload, restart and A to B pass. |
| Delete → re-import recovery | Pass. Delete warned; re-import resolved. |
| No-upload check | Pass. Only POST: register-usage-point (0.2 kB). |
| CLI parity | Pass. 360 frames, same colours. |

## WEB-007 golden checklist

${GOLDEN_A}

## Netlify check

- Phase A: pass. ready, commit matches, published; Functions: none
- Phase B: pass. ready, commit matches, published; Functions: none

## Failures

None.
`;

describe("GATE-001 G7 report", () => {
  it("lists the ASSET-006 Part B Record rows in the spec's order and wording", () => {
    assert.deepEqual(
      RECORD_ROWS.map(({label}) => label),
      [
        "Production URL",
        "Deploy A (commit / Netlify ID)",
        "Deploy B (commit / Netlify ID)",
        "Browser + version, profile",
        "Fixture refs",
        "Reload / restart / A → B results",
        "Delete → re-import recovery",
        "No-upload check",
        "CLI parity",
      ],
    );
  });

  it("covers every WEB-007 golden checklist item with a unique key", () => {
    assert.equal(GOLDEN_ITEMS.length, 12);
    assert.equal(new Set(GOLDEN_ITEMS.map(({key}) => key)).size, 12);
    assert.equal(
      new Set([...GOLDEN_ITEMS, ...RECORD_ROWS].map(({key}) => key)).size,
      GOLDEN_ITEMS.length + RECORD_ROWS.length,
    );
  });

  it("renders phase A only, leaving the B rows pending", () => {
    const state = phaseAState();

    assert.equal(renderReport(state, state.results), PHASE_A_REPORT);
  });

  it("renders A + B", () => {
    const state = fullState();

    assert.equal(renderReport(state, state.results), FULL_REPORT);
  });

  it("lists failures with their messages and flags the result", () => {
    const state = fullState();

    state.results.deleteReimport = {
      status: "fail",
      detail: "Render stayed enabled | after delete",
      phase: "B",
    };
    state.results[GOLDEN_ITEMS[2].key] = {status: "fail", detail: "pose did not change", phase: "A"};
    state.netlify.B = {status: "fail", detail: "commit mismatch: deploy da946d8, page abc"};

    const report = renderReport(state, state.results);

    assert.match(report, /^Result: FAIL$/m);
    assert.match(
      report,
      /\| Delete → re-import recovery \| \*\*FAIL\.\*\* Render stayed enabled \\\| after delete \|/,
    );
    assert.match(report, new RegExp(`- \\[ \\] \\*\\*FAIL\\*\\* ${GOLDEN_ITEMS[2].label}: pose did not change`));
    assert.match(report, /## Failures\n\n- \*\*Delete → re-import recovery\*\* \(phase B\): Render stayed enabled \| after delete\n/);
    assert.match(report, /- \*\*Netlify check, phase B\*\*: commit mismatch/);
    assert.match(report, /- Phase B: fail\. commit mismatch/);
  });

  it("marks a phase that ran without recording a result as incomplete", () => {
    const state = phaseAState();

    delete state.results.cliParity;

    const report = renderReport(state, state.results);

    assert.match(report, /^Result: INCOMPLETE$/m);
    assert.match(report, /\| CLI parity \| not recorded \|/);
  });

  it("reports a Netlify check that was skipped for a local target", () => {
    const state = phaseAState();

    state.netlify = {A: {status: "skip", detail: "not applicable to a local target"}};

    assert.match(
      renderReport(state, state.results),
      /## Netlify check\n\n- Phase A: skipped\. not applicable to a local target\n/,
    );
  });

  it("never prints fields outside the whitelist (no tokens)", () => {
    const state = fullState();

    state.token = "nfp_SECRET";
    state.a.token = "nfp_SECRET";
    state.netlify.A.token = "nfp_SECRET";

    assert.doesNotMatch(renderReport(state, state.results), /nfp_SECRET/);
  });

  it("writes report.md from state.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "gate-report-"));

    try {
      const stateDir = targetDir("local", root);

      await startPhaseA({
        stateDir,
        target: "local",
        url: "http://127.0.0.1:4190",
        now: "2026-10-10T10:00:00.000Z",
      });
      await mergePhase(stateDir, "A", {
        identity: {commit: "abc1234", deployId: "local-1", context: "local"},
      });
      await recordResult(stateDir, "cliParity", {status: "pass", detail: "ok", phase: "A"});

      const text = await writeReport(stateDir);
      const onDisk = await readFile(statePaths(stateDir).reportPath, "utf8");

      assert.equal(onDisk, text);
      assert.match(text, /^# Tora deployed verification: local\n/);
      assert.match(text, /\| CLI parity \| Pass\. ok \|/);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});
