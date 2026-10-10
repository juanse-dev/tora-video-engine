// GATE-001 G3/G4: gate environment and per-target state.
//
// State lives in git-ignored .gate/<target-slug>/:
//   profile/       Chrome user-data dir (shared by phase A and phase B)
//   state.json     phases, build identities and results (see report.mjs typedefs)
//   artifacts/     YAML, MP4s, decoded frames, network.json
//   report.md      rendered by report.mjs
//
// Specs write into state.json through mergePhase / recordResult /
// recordNetlify, never by editing the file themselves.

import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {basename, dirname, isAbsolute, join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {assertSafeSlug} from "../../../scripts/gateTarget.mjs";
import {allowsPreviewDrawer, formatIdentity} from "./buildIdentity.mjs";

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export const RESULT_STATUSES = ["pass", "fail", "skip", "pending"];

// Chrome can hold a just-closed profile for a moment on Windows (EBUSY).
const REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
};

const RUN_HINT = "npm run gate -- --url=<target> --phase=<A|B>";

/**
 * @typedef {import("./report.mjs").GateState} GateState
 * @typedef {import("./report.mjs").GateResult} GateResult
 * @typedef {import("./buildIdentity.mjs").BuildIdentity} BuildIdentity
 */

/**
 * Phase A and the profile snapshot step delete directories under the state
 * dir, so they only ever do it for a direct child of a `.gate` directory:
 * `<root>/.gate/<slug>`. Without `root` the parent just has to be named
 * `.gate`.
 *
 * @param {string} stateDir
 * @param {string} [root]  the repo root the state dir must live under
 */
export const assertInsideGateDir = (stateDir, root) => {
  const resolved = resolve(stateDir);
  const gateDir = root ? resolve(root, ".gate") : dirname(resolved);
  const inside = relative(gateDir, resolved);
  const direct =
    inside !== "" &&
    !isAbsolute(inside) &&
    !inside.includes("/") &&
    !inside.includes("\\") &&
    inside !== "." &&
    inside !== "..";

  if (basename(gateDir) !== ".gate" || !direct) {
    throw new Error(
      `Refusing to touch ${resolved}: a gate state directory must be a direct child of ${root ? gateDir : "a .gate directory"}.`,
    );
  }

  return resolved;
};

/**
 * @param {string} slug
 * @param {string} [root]
 */
export const targetDir = (slug, root = REPO_ROOT) => {
  assertSafeSlug(slug);

  return assertInsideGateDir(join(root, ".gate", slug), root);
};

/** @param {string} stateDir */
export const statePaths = (stateDir) => ({
  stateDir,
  profileDir: join(stateDir, "profile"),
  artifactsDir: join(stateDir, "artifacts"),
  statePath: join(stateDir, "state.json"),
  reportPath: join(stateDir, "report.md"),
  networkPath: join(stateDir, "artifacts", "network.json"),
  snapshotDir: join(stateDir, "profile-before-b"),
});

/**
 * What the Playwright config and specs read; set by scripts/gate.mjs.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export const readGateEnv = (env = process.env) => {
  const required = [
    "TORA_GATE_URL",
    "TORA_GATE_TARGET",
    "TORA_GATE_PHASE",
    "TORA_GATE_STATE_DIR",
  ];
  const missing = required.filter((name) => !env[name]);

  if (missing.length > 0) {
    throw new Error(
      `Gate environment is not set (${missing.join(", ")}). Run the gate through the runner instead of calling playwright directly: ${RUN_HINT}`,
    );
  }

  const phase = env.TORA_GATE_PHASE;

  if (phase !== "A" && phase !== "B") {
    throw new Error(`TORA_GATE_PHASE must be A or B, got "${phase}".`);
  }

  return {
    url: /** @type {string} */ (env.TORA_GATE_URL),
    target: /** @type {string} */ (env.TORA_GATE_TARGET),
    phase,
    local: env.TORA_GATE_LOCAL === "1",
    headed: env.TORA_GATE_HEADED === "1",
    stateDir: /** @type {string} */ (env.TORA_GATE_STATE_DIR),
  };
};

/**
 * @param {string} stateDir
 * @returns {Promise<GateState>}
 */
export const readState = async (stateDir) =>
  JSON.parse(await readFile(statePaths(stateDir).statePath, "utf8"));

/**
 * R10: the build context to pass to the network guard, read once from the
 * identity the build-identity spec recorded for this phase. Null (drawer POSTs
 * stay forbidden) when the context is production, unknown or not recorded.
 *
 * @param {string} stateDir
 * @param {"A" | "B"} phase
 * @returns {Promise<string | null>}
 */
export const previewDrawerContext = async (stateDir, phase) => {
  try {
    const state = await readState(stateDir);
    const identity = state[phase === "A" ? "a" : "b"]?.identity;

    return allowsPreviewDrawer(identity) ? identity.context : null;
  } catch {
    return null;
  }
};

/**
 * @param {string} stateDir
 * @param {GateState} state
 */
export const writeState = async (stateDir, state) => {
  await writeFile(
    statePaths(stateDir).statePath,
    `${JSON.stringify(state, null, 2)}\n`,
  );
};

/**
 * @param {string} stateDir
 * @param {(state: GateState) => void} change
 */
const updateState = async (stateDir, change) => {
  const state = await readState(stateDir);

  change(state);
  await writeState(stateDir, state);

  return state;
};

/**
 * Whether the state in `stateDir` is a phase A that passed (so phase B can,
 * or could, build on it). A missing or unreadable state.json is not.
 *
 * @param {string} stateDir
 * @returns {Promise<GateState | null>}
 */
const readPassedPhaseA = async (stateDir) => {
  /** @type {GateState} */
  let state;

  try {
    state = await readState(stateDir);
  } catch {
    return null;
  }

  return state.a?.identity && phaseAIncompleteReason(state) === null
    ? state
    : null;
};

/**
 * Whether phase B ran to the end and passed: finished, Playwright exit 0, and
 * no failed phase B result. Anything else leaves the A to B window open.
 *
 * @param {Pick<GateState, "b" | "results">} state
 */
const phaseBCompleted = (state) =>
  Boolean(state.b?.finishedAt) &&
  state.b?.exitCode === 0 &&
  !Object.values(state.results ?? {}).some(
    (result) => result.phase === "B" && result.status === "fail",
  );

/**
 * Phase A: delete and recreate the target dir, write a fresh state.json.
 *
 * Refuses when the dir holds a phase A that passed and whose A to B window is
 * still open (phase B not run, failed or incomplete) unless `fresh` is set:
 * phase A cannot be redone once Deploy B is live without another deploy, and
 * the profile it built is deleted here. After a completed, passing phase B the
 * next phase A starts without `--fresh`.
 *
 * @param {{stateDir: string, target: string, url: string, now?: string, fresh?: boolean, root?: string}} options
 * @returns {Promise<GateState>}
 */
export const startPhaseA = async ({
  stateDir,
  target,
  url,
  now = new Date().toISOString(),
  fresh = false,
  root,
}) => {
  assertInsideGateDir(stateDir, root);

  const paths = statePaths(stateDir);
  const earlier = fresh ? null : await readPassedPhaseA(stateDir);

  if (earlier && !phaseBCompleted(earlier)) {
    throw new Error(
      `Phase A already passed for ${earlier.url} (state at ${paths.statePath}) and ${earlier.b ? "phase B has not completed (it failed or was interrupted)" : "phase B has not run yet"}. Running phase A again deletes that profile, and redoing A after Deploy B is live costs another deploy. Run phase B instead, or to start over, pass --fresh: ${RUN_HINT.replace("<A|B>", "A")} --fresh`,
    );
  }

  await rm(stateDir, REMOVE_OPTIONS);
  await mkdir(paths.profileDir, {recursive: true});
  await mkdir(paths.artifactsDir, {recursive: true});

  /** @type {GateState} */
  const state = {
    version: 1,
    target,
    url,
    a: {startedAt: now},
    results: {},
    netlify: {},
  };

  await writeState(stateDir, state);

  return state;
};

/**
 * Phase B: load phase A's state with checks, then reset everything a previous
 * phase B run wrote (its phase data, its results, its Netlify check).
 *
 * @param {{stateDir: string, url: string, now?: string}} options
 * @returns {Promise<GateState>}
 */
export const startPhaseB = async ({
  stateDir,
  url,
  now = new Date().toISOString(),
}) => {
  /** @type {GateState} */
  let state;

  try {
    state = await readState(stateDir);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
      throw error;
    }

    throw new Error(
      `Phase B needs phase A's state, but there is none at ${statePaths(stateDir).statePath}. Run phase A first on this machine: ${RUN_HINT.replace("<A|B>", "A")}`,
    );
  }

  if (state.url !== url) {
    throw new Error(
      `Phase A was run for ${state.url}, not ${url}. Run phase A again for this URL: ${RUN_HINT.replace("<A|B>", "A")}`,
    );
  }

  if (!state.a?.identity) {
    throw new Error(
      `Phase A did not record a build identity (state at ${statePaths(stateDir).statePath}). Run phase A again until it passes the build-identity check.`,
    );
  }

  assertPhaseAPassed(state);

  state.b = {startedAt: now};
  state.results = Object.fromEntries(
    Object.entries(state.results).filter(([, result]) => result.phase !== "B"),
  );
  delete state.netlify.B;
  await writeState(stateDir, state);

  return state;
};

/**
 * @param {string} stateDir
 * @param {"A" | "B"} phase
 * @param {Record<string, unknown>} patch  shallow-merged into state.a / state.b
 */
export const mergePhase = (stateDir, phase, patch) =>
  updateState(stateDir, (state) => {
    const key = phase === "A" ? "a" : "b";

    state[key] = {...state[key], ...patch};
  });

/**
 * @param {string} stateDir
 * @param {string} key  a key listed in RECORD_ROWS or GOLDEN_ITEMS (report.mjs)
 * @param {{status: string, detail: string, phase?: "A" | "B"}} result
 */
export const recordResult = (stateDir, key, result) => {
  if (!RESULT_STATUSES.includes(result.status)) {
    return Promise.reject(
      new Error(
        `Result "${key}": status must be one of ${RESULT_STATUSES.join(", ")}, got "${result.status}".`,
      ),
    );
  }

  const phase = result.phase ?? process.env.TORA_GATE_PHASE;

  return updateState(stateDir, (state) => {
    /** @type {GateResult} */
    const entry = {
      status: /** @type {any} */ (result.status),
      detail: result.detail,
    };

    if (phase === "A" || phase === "B") {
      entry.phase = phase;
    }

    state.results[key] = entry;
  });
};

/**
 * @param {string} stateDir
 * @param {"A" | "B"} phase
 * @param {import("./report.mjs").NetlifyResult} result
 */
export const recordNetlify = (stateDir, phase, result) =>
  updateState(stateDir, (state) => {
    state.netlify[phase] = result;
  });

/**
 * Phase B must see a different build than phase A.
 *
 * @param {Pick<GateState, "a">} stateA
 * @param {BuildIdentity} identityB
 */
export const assertNewBuild = (stateA, identityB) => {
  const identityA = stateA.a?.identity;

  if (!identityA) {
    throw new Error("Phase A has no build identity to compare against.");
  }

  if (formatIdentity(identityA) === formatIdentity(identityB)) {
    throw new Error(
      `Deploy B is not live yet: still ${formatIdentity(identityB)}`,
    );
  }
};

/**
 * Runs `run`; when it throws, records a fail result under `key` (unless a more
 * specific fail is already recorded there) and rethrows. Specs wrap their body
 * in this so a failure that surfaces only as an exception still reaches the
 * report.
 *
 * @template T
 * @param {string} stateDir
 * @param {string} key
 * @param {() => Promise<T>} run
 * @param {{label?: string}} [options]  label prefixes the recorded detail (a step name)
 * @returns {Promise<T>}
 */
export const recordFailureOf = async (stateDir, key, run, {label} = {}) => {
  try {
    return await run();
  } catch (error) {
    // Bookkeeping must never replace the step's own error.
    try {
      const existing = (await readState(stateDir)).results[key];

      if (existing?.status !== "fail") {
        const message = (error instanceof Error ? error.message : String(error))
          // eslint-disable-next-line no-control-regex
          .replace(/\u001b\[[0-9;]*m/g, "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line !== "")
          .slice(0, 3)
          .join(" ");

        await recordResult(stateDir, key, {
          status: "fail",
          detail: label ? `${label}: ${message}` : message,
        });
      }
    } catch (recordError) {
      console.error(
        `could not record the failure of "${key}": ${recordError instanceof Error ? recordError.message : recordError}`,
      );
    }

    throw error;
  }
};

/**
 * Runs `run`, retrying on the transient EBUSY/EPERM/ENOTEMPTY that Windows
 * raises while Chrome (or an indexer) still holds a just-closed profile.
 *
 * @template T
 * @param {() => Promise<T>} run
 */
const withRetries = async (run) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;

      if (
        attempt >= 5 ||
        !["EBUSY", "EPERM", "ENOTEMPTY"].includes(code ?? "")
      ) {
        throw error;
      }

      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  }
};

/**
 * Phase B mutates the profile (it deletes the in-use pose in step 10), and
 * phase A cannot be redone once Deploy B is live. So the first phase B run
 * snapshots the profile (Chrome must be closed) and a rerun restores it first.
 * Phase A deletes the snapshot with the rest of the dir.
 *
 * Both directions copy to a `.tmp` sibling and rename it into place. A copy
 * that dies halfway (ENOSPC, Ctrl-C) therefore never leaves a partial snapshot
 * to be restored from, and the live profile is only removed after the copy
 * that replaces it is complete.
 *
 * @param {string} stateDir
 * @param {{copy?: (from: string, to: string) => Promise<void>}} [options]  copy is injectable for tests
 * @returns {Promise<{restored: boolean}>}
 */
export const prepareProfileForPhaseB = async (
  stateDir,
  {copy = (from, to) => cp(from, to, {recursive: true})} = {},
) => {
  assertInsideGateDir(stateDir);

  const {profileDir, snapshotDir} = statePaths(stateDir);
  const exists = async (/** @type {string} */ path) =>
    stat(path).then(
      () => true,
      () => false,
    );
  const removeDir = (/** @type {string} */ path) =>
    withRetries(() => rm(path, {recursive: true, force: true}));

  /**
   * Copies `from` to `${to}.tmp` (replacing a stale one), then renames it to
   * `to`, removing the existing `to` first when `replace` is set.
   */
  const copyInto = async (
    /** @type {string} */ from,
    /** @type {string} */ to,
    /** @type {boolean} */ replace,
  ) => {
    const tmp = `${to}.tmp`;

    await removeDir(tmp);

    try {
      await withRetries(() => copy(from, tmp));
    } catch (error) {
      await removeDir(tmp).catch(() => {});
      throw error;
    }

    if (replace) {
      await removeDir(to);
    }

    await withRetries(() => rename(tmp, to));
  };

  if (await exists(snapshotDir)) {
    await copyInto(snapshotDir, profileDir, true);

    return {restored: true};
  }

  if (!(await exists(profileDir))) {
    throw new Error(
      `There is no profile at ${profileDir} to snapshot for phase B. Run phase A first.`,
    );
  }

  await copyInto(profileDir, snapshotDir, false);

  return {restored: false};
};

/**
 * Why phase A cannot be trusted as the base for phase B, or null when it can.
 * The one predicate behind both the phase B precondition and the `--fresh`
 * check in `startPhaseA`.
 *
 * @param {Pick<GateState, "a" | "results">} state
 * @returns {string | null}
 */
export const phaseAIncompleteReason = (state) => {
  const reasons = [];

  for (const field of ["reloadDetail", "profileMarker", "networkSummary"]) {
    if (!state.a?.[field]) {
      reasons.push(`state.a.${field} is missing`);
    }
  }

  // A Playwright run that died before recording an item-level failure (for
  // example a beforeAll that could not launch Chrome) leaves these unset or
  // non-zero even when the three fields above were filled earlier.
  if (!state.a?.finishedAt) {
    reasons.push("state.a.finishedAt is missing (phase A did not finish)");
  }

  const exitCode = state.a?.exitCode;

  if (typeof exitCode !== "number") {
    reasons.push("state.a.exitCode is missing (Playwright exit code unknown)");
  } else if (exitCode !== 0) {
    reasons.push(`Playwright exit code ${exitCode}`);
  }

  for (const [key, result] of Object.entries(state.results ?? {})) {
    if (result.phase === "A" && result.status === "fail") {
      reasons.push(`${key} failed: ${result.detail}`);
    }
  }

  return reasons.length > 0 ? reasons.join("; ") : null;
};

/** @param {Pick<GateState, "a" | "results">} state */
export const assertPhaseAPassed = (state) => {
  const reason = phaseAIncompleteReason(state);

  if (reason) {
    throw new Error(
      `Phase A did not pass (${reason}); rerun phase A before phase B`,
    );
  }
};
