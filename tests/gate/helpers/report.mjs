// GATE-001 G7: report.md, the Markdown the user pastes as is.
//
// Specs and the runner never write the report by hand. They record into
// state.json (see gateState.mjs) and the report is rendered from it:
//
//   await mergePhase(stateDir, "A", {identity, browser: {name, version}, refs: {pose, background}});
//   await recordResult(stateDir, "reload", {status: "pass", detail: "..."});
//   await writeReport(stateDir);
//
// The ASSET-006 Part B Record rows and the WEB-007 golden items below are
// the complete list of result keys; each row says which phase owns it.

/**
 * @typedef {{commit: string, deployId: string, context: string}} BuildIdentity
 *
 * @typedef {"pass" | "fail" | "skip" | "pending"} ResultStatus
 *
 * One checked item. "pending" means "this phase did its part, a later phase
 * finishes it" (for example the A half of the A -> B row). `phase` is stamped
 * by recordResult from TORA_GATE_PHASE; a new phase B run drops B's results.
 * @typedef {{status: ResultStatus, detail: string, phase?: "A" | "B"}} GateResult
 *
 * Results by key. Keys are the `key` fields of RECORD_ROWS (the result-driven
 * rows: reload, deleteReimport, noUpload, cliParity) and GOLDEN_ITEMS.
 * @typedef {Record<string, GateResult>} GateResults
 *
 * @typedef {{name?: string, version: string}} BrowserInfo
 *
 * Per-phase data. startedAt is set by the runner; identity by
 * build-identity.spec; the rest by the gate spec (T2). refs is phase A only.
 * @typedef {{
 *   startedAt: string,
 *   finishedAt?: string,
 *   identity?: BuildIdentity,
 *   browser?: BrowserInfo,
 *   refs?: {pose: string, background: string},
 * } & Record<string, unknown>} PhaseState
 *
 * "manual" = no token. "skip" = not applicable (local target, or no identity).
 * @typedef {{
 *   status: "pass" | "fail" | "manual" | "skip",
 *   detail: string,
 *   checks?: Array<{name: string, ok: boolean, detail: string}>,
 * }} NetlifyResult
 *
 * state.json
 * @typedef {{
 *   version: 1,
 *   target: string,
 *   url: string,
 *   a: PhaseState,
 *   b?: PhaseState,
 *   results: GateResults,
 *   netlify: {A?: NetlifyResult, B?: NetlifyResult},
 * }} GateState
 */

import {readFile, writeFile} from "node:fs/promises";
import {statePaths} from "./gateState.mjs";

// owner = the phases that write the row: "A", "B" or "AB" (A records a
// "pending" half, B overwrites it). Rows without an owner are derived from
// state, not recorded.
export const RECORD_ROWS = [
  {key: "productionUrl", label: "Production URL"},
  {key: "deployA", label: "Deploy A (commit / Netlify ID)"},
  {key: "deployB", label: "Deploy B (commit / Netlify ID)"},
  {key: "browser", label: "Browser + version, profile"},
  {key: "fixtureRefs", label: "Fixture refs"},
  {key: "reload", label: "Reload / restart / A → B results", owner: "AB"},
  {key: "deleteReimport", label: "Delete → re-import recovery", owner: "B"},
  {key: "noUpload", label: "No-upload check", owner: "AB"},
  {key: "cliParity", label: "CLI parity", owner: "A"},
];

// The WEB-007 manual golden checklist, phase A only (T3).
export const GOLDEN_ITEMS = [
  {key: "golden.appLoads", label: "App loads with bundled poses and backgrounds"},
  {key: "golden.captionEdit", label: "Caption edit"},
  {key: "golden.poseChange", label: "Pose change"},
  {key: "golden.sceneReorder", label: "Scene reorder"},
  {key: "golden.playerFollowsStory", label: "The Player follows the Active Story"},
  {key: "golden.yamlExport", label: "YAML export"},
  {key: "golden.reloadRestores", label: "Reload restores the edits"},
  {key: "golden.renderCapability", label: "Render capability is ready"},
  {
    key: "golden.renderDownload",
    label:
      "Render + download with metadata (video-only H.264, 1080×1920, 30 FPS, 360 frames / 12 s)",
  },
  {key: "golden.cancelRender", label: "Cancel Render aborts and unlocks authoring"},
  {key: "golden.pendingDraftBlocks", label: "A pending draft blocks rendering"},
  {
    key: "golden.inFlightLocks",
    label: "An in-flight render locks authoring until it settles",
  },
];

/** @param {string} text */
const cell = (text) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();

/** @param {string} text */
const oneLine = (text) => text.replace(/\s*\n\s*/g, " ").trim();

const code = (/** @type {string} */ text) => `\`${text}\``;

/** @param {BuildIdentity} identity */
const deployCell = ({commit, deployId, context}) =>
  `${code(commit)} / ${code(deployId)} (${context})`;

const STATUS_WORD = {pass: "Pass.", skip: "Skipped.", pending: "Pending."};

/** @param {GateResult} result */
const rowText = (result) => {
  const head =
    result.status === "fail" ? "**FAIL.**" : STATUS_WORD[result.status];

  return oneLine(`${head} ${result.detail ?? ""}`);
};

/**
 * @param {GateState} state
 * @param {GateResults} results
 * @returns {string}
 */
export const renderReport = (state, results) => {
  const {a, b} = state;
  const hasB = Boolean(b);
  /** @type {string[]} */
  const failures = [];
  let incomplete = false;

  /**
   * A result-driven row or golden item that has no result: pending while its
   * owner phases have not all run, otherwise a gap.
   *
   * @param {string} owner
   */
  const missing = (owner) => {
    if (owner.includes("B") && !hasB) {
      return "pending phase B";
    }

    incomplete = true;

    return "not recorded";
  };

  /** @param {typeof RECORD_ROWS[number]} row */
  const derived = (row) => {
    switch (row.key) {
      case "productionUrl":
        return state.target === "prod"
          ? code(state.url)
          : `${code(state.url)} (target ${code(state.target)}, not production)`;
      case "deployA":
        if (a.identity) return deployCell(a.identity);
        incomplete = true;
        return "not recorded";
      case "deployB":
        return b?.identity ? deployCell(b.identity) : missing("B");
      case "browser": {
        const browser = a.browser ?? b?.browser;

        if (!browser) {
          incomplete = true;
          return "not recorded";
        }

        const name = (info) => `${info.name ?? "Chrome"} ${info.version}`;
        const changed =
          b?.browser && a.browser && b.browser.version !== a.browser.version
            ? ` (phase B: ${name(b.browser)})`
            : "";

        return `${name(browser)}${changed}; gate profile ${code(`.gate/${state.target}/profile`)} (dedicated, created fresh by phase A)`;
      }
      case "fixtureRefs":
        if (a.refs) return `${code(a.refs.pose)}, ${code(a.refs.background)}`;
        incomplete = true;
        return "not recorded";
      default:
        return "";
    }
  };

  const rows = RECORD_ROWS.map((row) => {
    if (!row.owner) {
      return `| ${row.label} | ${cell(derived(row))} |`;
    }

    const result = results[row.key];

    if (!result) {
      return `| ${row.label} | ${missing(row.owner)} |`;
    }

    if (result.status === "fail") {
      failures.push(
        `- **${row.label}**${result.phase ? ` (phase ${result.phase})` : ""}: ${oneLine(result.detail)}`,
      );
    } else if (result.status === "pending" && hasB) {
      incomplete = true;
    }

    return `| ${row.label} | ${cell(rowText(result))} |`;
  });

  const golden = GOLDEN_ITEMS.map(({key, label}) => {
    const result = results[key];

    if (!result) {
      return `- [ ] ${label}: ${missing("A")}`;
    }

    const detail = result.detail ? `: ${oneLine(result.detail)}` : "";

    if (result.status === "fail") {
      failures.push(
        `- **${label}**${result.phase ? ` (phase ${result.phase})` : ""}: ${oneLine(result.detail)}`,
      );

      return `- [ ] **FAIL** ${label}${detail}`;
    }

    if (result.status === "pass") {
      return `- [x] ${label}${detail}`;
    }

    if (result.status === "pending" && hasB) {
      incomplete = true;
    }

    return `- [ ] ${label} (${result.status})${detail}`;
  });

  const netlifyEntries = /** @type {Array<["A" | "B", NetlifyResult]>} */ (
    ["A", "B"]
      .filter((phase) => state.netlify?.[phase])
      .map((phase) => [phase, state.netlify[phase]])
  );
  const netlifyWord = {pass: "pass", fail: "fail", manual: "manual", skip: "skipped"};

  for (const [phase, result] of netlifyEntries) {
    if (result.status === "fail") {
      failures.push(`- **Netlify check, phase ${phase}**: ${oneLine(result.detail)}`);
    }
  }

  const netlify =
    netlifyEntries.length === 0 ||
    netlifyEntries.every(([, result]) => result.status === "manual")
      ? "Netlify check: manual (no token)"
      : netlifyEntries
          .map(
            ([phase, result]) =>
              `- Phase ${phase}: ${netlifyWord[result.status]}. ${oneLine(result.detail)}`,
          )
          .join("\n");

  const verdict =
    failures.length > 0
      ? "FAIL"
      : incomplete
        ? "INCOMPLETE"
        : hasB
          ? "PASS"
          : "PHASE A PASSED (phase B pending)";

  /** @param {PhaseState | undefined} phase */
  const span = (phase) =>
    !phase
      ? "pending"
      : phase.finishedAt
        ? `${phase.startedAt} to ${phase.finishedAt}`
        : `started ${phase.startedAt}`;

  return [
    `# Tora deployed verification: ${state.target}`,
    "",
    `Result: ${verdict}`,
    "",
    `- URL: ${state.url}`,
    `- Phase A: ${span(a)}`,
    `- Phase B: ${span(b)}`,
    "",
    "## ASSET-006 Part B Record",
    "",
    "| Item | Value |",
    "| --- | --- |",
    ...rows,
    "",
    "## WEB-007 golden checklist",
    "",
    ...golden,
    "",
    "## Netlify check",
    "",
    netlify,
    "",
    "## Failures",
    "",
    ...(failures.length > 0 ? failures : ["None."]),
    "",
  ].join("\n");
};

/**
 * Renders report.md from state.json.
 *
 * @param {string} stateDir
 * @returns {Promise<string>} the Markdown
 */
export const writeReport = async (stateDir) => {
  const {statePath, reportPath} = statePaths(stateDir);
  const state = /** @type {GateState} */ (
    JSON.parse(await readFile(statePath, "utf8"))
  );
  const text = renderReport(state, state.results);

  await writeFile(reportPath, text);

  return text;
};
