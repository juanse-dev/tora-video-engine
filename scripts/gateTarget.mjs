// GATE-001 G2: argument parsing and target resolution for scripts/gate.mjs.
// Pure (no I/O) so it is unit-tested in tests/gate-runner.test.mjs.

import process from "node:process";
import {URL} from "node:url";

export const PROD_ORIGIN = "https://tora-video-engine.netlify.app";
export const LOCAL_ORIGIN = "http://127.0.0.1:4190";

export const USAGE = [
  "Usage: npm run gate -- --url=<target> --phase=<A|B> [--headed] [--only=<grep>] [--fresh]",
  "  target: prod | preview:<n> | local | https://<origin>",
  "  --fresh: phase A only; start over even when a finished phase A is waiting for phase B",
  "  Windows PowerShell 5.1 (npm.ps1) can drop the `--`; use `npm.cmd run gate -- ...` or `node scripts/gate.mjs ...`.",
].join("\n");

const SHELL_HINT =
  "Windows PowerShell 5.1 can drop the `--` from `npm run gate -- ...`; use `npm.cmd run gate -- --url=<target> --phase=<A|B>` or `node scripts/gate.mjs --url=<target> --phase=<A|B>`.";

/**
 * A target slug becomes a directory name under .gate/, and phase A deletes
 * that directory, so it must be a plain name: never empty, "." or "..", and
 * only lower-case letters, digits, "." and "-".
 *
 * @param {unknown} slug
 * @returns {string}
 */
export const assertSafeSlug = (slug) => {
  if (
    typeof slug !== "string" ||
    slug === "" ||
    slug === "." ||
    slug === ".." ||
    !/^[a-z0-9.-]+$/.test(slug)
  ) {
    throw new Error(
      `Unsafe target slug ${JSON.stringify(slug)}: a slug must be non-empty, not "." or "..", and use only a-z, 0-9, "." and "-".`,
    );
  }

  return slug;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * @typedef {{url: string, phase: "A" | "B", headed: boolean, only: string | undefined, fresh: boolean}} GateArgs
 * @typedef {{name: string, slug: string, url: string, local: boolean}} GateTarget
 */

/**
 * Windows PowerShell 5.1 runs npm through npm.ps1, which drops the `--`, so
 * npm swallows `--url=x --phase=A` as its own config and exports them as
 * npm_config_url, npm_config_phase, ... with an empty argv. When argv has no
 * --url, those variables are used instead.
 *
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 * @returns {GateArgs}
 */
export const parseGateArgs = (argv, env = process.env) => {
  /** @type {Record<string, string | true>} */
  const values = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const match = /^--(url|phase|only|headed|fresh)(?:=(.*))?$/.exec(arg);

    if (!match) {
      throw new Error(`Unknown argument "${arg}".`);
    }

    const [, name, inline] = match;

    if (name === "headed" || name === "fresh") {
      if (inline !== undefined) {
        throw new Error(`--${name} takes no value.`);
      }

      values[name] = true;
      continue;
    }

    let value = inline;

    if (value === undefined) {
      const next = argv[index + 1];

      if (next === undefined || next.startsWith("--")) {
        throw new Error(`--${name} needs a value.`);
      }

      value = next;
      index += 1;
    }

    values[name] = value;
  }

  if (values.url === undefined) {
    for (const name of ["url", "phase", "only"]) {
      const fromNpm = env[`npm_config_${name}`];

      if (values[name] === undefined && fromNpm) {
        values[name] = fromNpm;
      }
    }

    for (const name of ["headed", "fresh"]) {
      if (values[name] === undefined && env[`npm_config_${name}`] === "true") {
        values[name] = true;
      }
    }
  }

  if (typeof values.url !== "string" || values.url === "") {
    throw new Error(
      `--url is required (prod, preview:<n>, local or an https:// URL). ${SHELL_HINT}`,
    );
  }

  if (typeof values.phase !== "string") {
    throw new Error("--phase is required (A or B).");
  }

  const phase = values.phase.toUpperCase();

  if (phase !== "A" && phase !== "B") {
    throw new Error(`--phase must be A or B, got "${values.phase}".`);
  }

  return {
    url: values.url,
    phase,
    headed: values.headed === true,
    only: typeof values.only === "string" ? values.only : undefined,
    fresh: values.fresh === true,
  };
};

/**
 * @param {string} value
 * @returns {GateTarget}
 */
export const resolveTarget = (value) => {
  if (value === "prod") {
    return {name: "prod", slug: "prod", url: PROD_ORIGIN, local: false};
  }

  if (value === "local") {
    return {name: "local", slug: "local", url: LOCAL_ORIGIN, local: true};
  }

  if (value.startsWith("preview:")) {
    const digits = value.slice("preview:".length);

    if (!/^[1-9][0-9]*$/.test(digits)) {
      throw new Error(
        `Invalid target "${value}": preview:<n> needs a positive pull request number.`,
      );
    }

    return {
      name: value,
      slug: `preview-${digits}`,
      url: `https://deploy-preview-${digits}--tora-video-engine.netlify.app`,
      local: false,
    };
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    throw new Error(
      `Unknown target "${value}". Use prod, preview:<n>, local or an https:// URL.`,
    );
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid target URL "${value}".`);
  }

  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);

  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(
      `Refusing "${value}": only https:// URLs are allowed (http:// only for a loopback host).`,
    );
  }

  if (
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error(
      `Target "${value}" must be an origin only (scheme, host and optional port), with no path, query, fragment or credentials.`,
    );
  }

  if (parsed.origin === PROD_ORIGIN) {
    return resolveTarget("prod");
  }

  // "host-" keeps custom hosts apart from the built-in slugs (a host named
  // "prod" or "local"); stripping the edges leaves nothing for a host such as
  // ".." or ".", which would otherwise name .gate/ or the repo root.
  const hostName = parsed.host
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  if (hostName === "") {
    throw new Error(
      `Invalid target "${value}": the host has no usable name for a state directory.`,
    );
  }

  return {
    name: parsed.origin,
    slug: assertSafeSlug(`host-${hostName}`),
    url: parsed.origin,
    local: false,
  };
};

/**
 * Environment the Playwright config and specs read (see readGateEnv in
 * tests/gate/helpers/gateState.mjs).
 *
 * @param {{target: GateTarget, phase: "A" | "B", headed: boolean, stateDir: string}} options
 * @returns {Record<string, string>}
 */
export const buildGateEnv = ({target, phase, headed, stateDir}) => ({
  TORA_GATE_URL: target.url,
  TORA_GATE_TARGET: target.slug,
  TORA_GATE_PHASE: phase,
  TORA_GATE_LOCAL: target.local ? "1" : "0",
  TORA_GATE_HEADED: headed ? "1" : "0",
  TORA_GATE_STATE_DIR: stateDir,
});
