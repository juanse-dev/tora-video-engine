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

import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {formatIdentity} from "./buildIdentity.mjs";

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
 * @param {string} slug
 * @param {string} [root]
 */
export const targetDir = (slug, root = REPO_ROOT) =>
  join(root, ".gate", slug);

/** @param {string} stateDir */
export const statePaths = (stateDir) => ({
  stateDir,
  profileDir: join(stateDir, "profile"),
  artifactsDir: join(stateDir, "artifacts"),
  statePath: join(stateDir, "state.json"),
  reportPath: join(stateDir, "report.md"),
  networkPath: join(stateDir, "artifacts", "network.json"),
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
 * Phase A: delete and recreate the target dir, write a fresh state.json.
 *
 * @param {{stateDir: string, target: string, url: string, now?: string}} options
 * @returns {Promise<GateState>}
 */
export const startPhaseA = async ({
  stateDir,
  target,
  url,
  now = new Date().toISOString(),
}) => {
  const paths = statePaths(stateDir);

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
    const entry = {status: /** @type {any} */ (result.status), detail: result.detail};

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
 * @returns {Promise<T>}
 */
export const recordFailureOf = async (stateDir, key, run) => {
  try {
    return await run();
  } catch (error) {
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

      await recordResult(stateDir, key, {status: "fail", detail: message});
    }

    throw error;
  }
};
