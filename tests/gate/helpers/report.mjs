// GATE-001 G7: report.md, the Markdown the user pastes as is.
//
// Specs and the runner never write the report by hand. They record into
// state.json (see gateState.mjs) and the report is rendered from it:
//
//   await mergePhase(stateDir, "A", {identity, browser: {name, version}, refs: {pose, background}});
//   await recordResult(stateDir, "reload", {status: "pass", detail: "..."});
//   await writeReport(stateDir);
//
// The ASSET-006 Part B Record rows and the WEB-007 golden items (phaseOutcome.mjs,
// re-exported here) are the complete list of result keys; each row says which
// phase owns it. The verdict comes from phaseOutcome, the same function the
// phase B precondition and the phase A --fresh guard use (R11).

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
 * Per-phase data. The runner sets startedAt, finishedAt, exitCode (Playwright's)
 * and playwrightSummary (first lines of a failing run); identity is set by
 * build-identity.spec; the rest by the gate spec (T2). refs is phase A only.
 * @typedef {{
 *   startedAt: string,
 *   finishedAt?: string,
 *   exitCode?: number,
 *   playwrightSummary?: string,
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
import {GOLDEN_ITEMS, RECORD_ROWS, phaseOutcome} from "./phaseOutcome.mjs";

export {GOLDEN_ITEMS, RECORD_ROWS, phaseOutcome};

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
        return a.identity ? deployCell(a.identity) : "not recorded";
      case "deployB":
        return b?.identity ? deployCell(b.identity) : missing("B");
      case "browser": {
        const browser = a.browser ?? b?.browser;

        if (!browser) {
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
        return a.refs
          ? `${code(a.refs.pose)}, ${code(a.refs.background)}`
          : "not recorded";
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

    return `- [ ] ${label} (${result.status})${detail}`;
  });

  // Results under keys the tables do not show (a spec's own failure, for
  // example the build-identity guard) must still reach the failure list.
  const known = new Set([...RECORD_ROWS, ...GOLDEN_ITEMS].map(({key}) => key));

  for (const [key, result] of Object.entries(results)) {
    if (!known.has(key) && result.status === "fail") {
      failures.push(
        `- **${key}**${result.phase ? ` (phase ${result.phase})` : ""}: ${oneLine(result.detail)}`,
      );
    }
  }

  const netlifyWord = {pass: "pass", fail: "fail", manual: "manual", skip: "skipped"};
  const RECORDED = Object.keys(netlifyWord);
  /** A phase that ran, or that has a valid record, in phase order. */
  const netlifyPhases = /** @type {Array<"A" | "B">} */ (["A", "B"]).filter(
    (phase) =>
      (phase === "A" ? a : b) || RECORDED.includes(state.netlify?.[phase]?.status),
  );
  const recordedResult = (/** @type {"A" | "B"} */ phase) => {
    const result = state.netlify?.[phase];

    return RECORDED.includes(result?.status) ? result : null;
  };

  for (const phase of netlifyPhases) {
    const result = recordedResult(phase);

    if (result?.status === "fail") {
      failures.push(`- **Netlify check, phase ${phase}**: ${oneLine(result.detail)}`);
    }
  }

  const netlify = netlifyPhases.every(
    (phase) => recordedResult(phase)?.status === "manual",
  )
    ? "Netlify check: manual (no token)"
    : netlifyPhases
        .map((phase) => {
          const result = recordedResult(phase);

          return result
            ? `- Phase ${phase}: ${netlifyWord[result.status]}. ${oneLine(result.detail)}`
            : `- Phase ${phase}: not recorded`;
        })
        .join("\n");

  // A non-zero Playwright exit is a failure even when no spec recorded one
  // (a timeout, a crash, a thrown assertion).
  for (const [phase, data] of /** @type {Array<["A" | "B", PhaseState | undefined]>} */ ([
    ["A", a],
    ["B", b],
  ])) {
    if (data && typeof data.exitCode === "number" && data.exitCode !== 0) {
      const summary = data.playwrightSummary
        ? `\n\`\`\`\n${data.playwrightSummary}\n\`\`\``
        : "";

      failures.push(
        `- **Playwright, phase ${phase}**: exited with code ${data.exitCode}${summary}`,
      );
    }
  }

  // The verdict is a function of the two phase outcomes alone (R11). The
  // lists above only explain it.
  const outcomeState = {...state, results};
  const outcomeA = phaseOutcome(outcomeState, "A");
  const outcomeB = phaseOutcome(outcomeState, "B");

  if ((outcomeA.failed || outcomeB.failed) && failures.length === 0) {
    failures.push(
      ...[outcomeA, outcomeB].flatMap(({failed, reasons}) =>
        failed ? reasons.map((reason) => `- ${oneLine(reason)}`) : [],
      ),
    );
  }

  const verdict =
    outcomeA.failed || outcomeB.failed
      ? "FAIL"
      : !outcomeA.passed || (hasB && !outcomeB.passed)
        ? "INCOMPLETE"
        : hasB
          ? "PASS"
          : "PHASE A PASSED (phase B pending)";

  // Why a report is INCOMPLETE, so it is never silent about it.
  const incompleteReasons =
    verdict === "INCOMPLETE"
      ? /** @type {Array<["A" | "B", typeof outcomeA]>} */ ([
          ["A", outcomeA],
          ...(hasB ? [["B", outcomeB]] : []),
        ]).flatMap(([phase, outcome]) =>
          outcome.passed
            ? []
            : outcome.reasons.map((reason) => `- Phase ${phase}: ${oneLine(reason)}`),
        )
      : [];

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
    ...(incompleteReasons.length > 0
      ? ["## Incomplete", "", ...incompleteReasons, ""]
      : []),
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
