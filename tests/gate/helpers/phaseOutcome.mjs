// GATE-001 R11: the one definition of "phase X passed".
//
// The report verdict (report.mjs), the phase B precondition and the phase A
// `--fresh` guard (gateState.mjs) all read phaseOutcome, so they cannot
// disagree: a run that renders INCOMPLETE or FAIL is never treated as a passed
// phase. The row and golden lists live here (report.mjs re-exports them)
// because both modules need them and report.mjs already imports gateState.mjs.

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

// The golden spec's own network-guard result, under a key the tables do not
// show (R5), but a phase A without it did not run the golden.
const GOLDEN_NETWORK_KEY = "goldenNetwork";

const rowKeys = (/** @type {"A" | "B"} */ phase) =>
  RECORD_ROWS.filter((row) => row.owner?.includes(phase)).map(({key}) => key);

// R12: the shared "AB" rows (reload, noUpload) are not evidence of phase A.
// Phase B overwrites them, and a phase B rerun deletes whatever B stamped, so
// phase A's halves are proven by state.a.reloadDetail / state.a.networkSummary.
const ownedByA = (/** @type {string} */ key) =>
  RECORD_ROWS.find((row) => row.key === key)?.owner === "A";

/**
 * Result keys a phase A that ran in full records; each must be a pass.
 * Skipped items (what `--only` leaves behind) and pending ones do not count.
 */
export const PHASE_A_RESULT_KEYS = [
  ...rowKeys("A").filter(ownedByA),
  ...GOLDEN_ITEMS.map(({key}) => key),
  GOLDEN_NETWORK_KEY,
];

/** Result keys a phase B that ran in full records. */
export const PHASE_B_RESULT_KEYS = rowKeys("B");

// Phase A keeps these on state.a once its gate spec ran to the end.
const PHASE_A_FIELDS = ["reloadDetail", "profileMarker", "networkSummary"];

/**
 * @typedef {{passed: boolean, failed: boolean, reasons: string[]}} PhaseOutcome
 *   passed  = nothing is missing, failing or unfinished;
 *   failed  = something ran and failed (a failed result, a non-zero Playwright
 *             exit, a failed Netlify check), as opposed to merely not having run.
 */

/**
 * Whether phase `phase` of `state` passed, and if not, why. Every mandatory
 * result must be present and not failing, the phase must have finished with
 * Playwright exit code 0, and its Netlify check must be recorded and not failed ("pass", "skip"
 * and "manual" are fine). A run with `--only` leaves mandatory results out and
 * so never passes.
 *
 * @param {Pick<import("./report.mjs").GateState, "a" | "b" | "results"> & {netlify?: import("./report.mjs").GateState["netlify"]}} state
 * @param {"A" | "B"} phase
 * @returns {PhaseOutcome}
 */
export const phaseOutcome = (state, phase) => {
  const field = phase === "A" ? "a" : "b";
  const data = state[field];
  const results = state.results ?? {};
  /** @type {string[]} */
  const reasons = [];
  let failed = false;

  /** @param {string} reason */
  const fail = (reason) => {
    failed = true;
    reasons.push(reason);
  };

  if (!data) {
    reasons.push(`phase ${phase} has not run`);
  } else {
    if (!data.identity) {
      reasons.push(`state.${field}.identity is missing (no build identity)`);
    }

    if (phase === "A") {
      if (!data.browser) {
        reasons.push("state.a.browser is missing");
      }

      if (!data.refs) {
        reasons.push("state.a.refs is missing (fixture refs)");
      }

      for (const name of PHASE_A_FIELDS) {
        if (!data[name]) {
          reasons.push(`state.a.${name} is missing`);
        }
      }
    }

    // A Playwright run that died before recording an item-level failure (for
    // example a beforeAll that could not launch Chrome) leaves these unset or
    // non-zero even when everything above was filled earlier.
    if (!data.finishedAt) {
      reasons.push(
        `state.${field}.finishedAt is missing (phase ${phase} did not finish)`,
      );
    }

    if (typeof data.exitCode !== "number") {
      reasons.push(
        `state.${field}.exitCode is missing (Playwright exit code unknown)`,
      );
    } else if (data.exitCode !== 0) {
      fail(`Playwright exit code ${data.exitCode}`);
    }

    const required = phase === "A" ? PHASE_A_RESULT_KEYS : PHASE_B_RESULT_KEYS;
    /** @type {string[]} */
    const notRecorded = [];

    for (const key of required) {
      const result = results[key];

      // Phase B owns the second half of a row phase A left "pending".
      const bPartMissing =
        phase === "B" &&
        result !== undefined &&
        (result.phase === "A" || result.status === "pending");

      if (!result || bPartMissing) {
        notRecorded.push(phase === "B" ? `${key} (phase B part)` : key);
      } else if (result.status !== "fail" && result.status !== "pass") {
        reasons.push(`${key} is ${result.status}, not pass`);
      }
    }

    if (notRecorded.length > 0) {
      reasons.push(`not recorded: ${notRecorded.join(", ")}`);
    }
  }

  // Failures count for the phase that stamped them; an unstamped result
  // (recorded outside the runner) counts for both.
  for (const [key, result] of Object.entries(results)) {
    if (
      result.status === "fail" &&
      (result.phase === phase || result.phase === undefined)
    ) {
      fail(`${key} failed: ${result.detail}`);
    }
  }

  // The runner records finishedAt and the exit code before it runs the
  // Netlify step, so an interrupted run has everything else but this. pass,
  // skip and manual are fine; fail and absent are not.
  const netlify = state.netlify?.[phase];

  if (netlify?.status === "fail") {
    fail(`Netlify check failed: ${netlify.detail}`);
  } else if (!netlify && data) {
    reasons.push("Netlify check not recorded");
  }

  return {passed: reasons.length === 0, failed, reasons};
};
