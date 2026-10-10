// GATE-001 G2: argument parsing and target resolution for scripts/gate.mjs.
// Pure (no I/O) so it is unit-tested in tests/gate-runner.test.mjs.

import {URL} from "node:url";

export const PROD_ORIGIN = "https://tora-video-engine.netlify.app";
export const LOCAL_ORIGIN = "http://127.0.0.1:4190";

export const USAGE = [
  "Usage: npm run gate -- --url=<target> --phase=<A|B> [--headed] [--only=<grep>]",
  "  target: prod | preview:<n> | local | https://<origin>",
].join("\n");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * @typedef {{url: string, phase: "A" | "B", headed: boolean, only: string | undefined}} GateArgs
 * @typedef {{name: string, slug: string, url: string, local: boolean}} GateTarget
 */

/**
 * @param {string[]} argv
 * @returns {GateArgs}
 */
export const parseGateArgs = (argv) => {
  /** @type {Record<string, string | true>} */
  const values = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const match = /^--(url|phase|only|headed)(?:=(.*))?$/.exec(arg);

    if (!match) {
      throw new Error(`Unknown argument "${arg}".`);
    }

    const [, name, inline] = match;

    if (name === "headed") {
      if (inline !== undefined) {
        throw new Error("--headed takes no value.");
      }

      values.headed = true;
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

  if (typeof values.url !== "string" || values.url === "") {
    throw new Error("--url is required (prod, preview:<n>, local or an https:// URL).");
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

  return {
    name: parsed.origin,
    slug: parsed.host.replace(/[^a-z0-9.]+/g, "-"),
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
