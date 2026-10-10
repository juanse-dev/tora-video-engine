// GATE-001 G6: network guard for every browser context the suite opens.
//
// A violation is
//   - any request whose method is not GET / HEAD / OPTIONS, unless it matches
//     the allowlist below; and
//   - any request whose body contains a PNG (89 50 4E 47) or JPEG (FF D8 FF)
//     signature, or the bytes of a fixture, whatever the method or host.
//
// Limit: Chromium may report postDataBuffer() as null or truncated for large
// or streamed (ReadableStream) bodies, so the signature and fixture checks can
// miss such a body. The method rule does not depend on the body: any non-GET
// request outside the allowlist is still a violation, which is what catches an
// upload sent that way.
//
// The guard observes (it does not block): violations fail the phase at the
// end, listing each one. Every non-GET request and every contacted host is
// kept for artifacts/network.json (saveNetworkLog) and the report.
//
// ALLOWLIST: a new entry needs a ledgered ruling that names the request and
// says why it carries no user data.

import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname} from "node:path";

export const TELEMETRY_MAX_BYTES = 4096;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

const ALLOWLIST = [
  {
    // Remotion licence telemetry, sent for each browser render. Ruled in
    // ASSET-006 Part B (0.2 kB, no user data).
    name: "remotion-register-usage-point",
    method: "POST",
    pathSuffix: "/register-usage-point",
    maxBytes: TELEMETRY_MAX_BYTES,
  },
];

/**
 * @typedef {{method: string, url: string, body?: Buffer | Uint8Array | string | null}} RequestInfo
 * @typedef {{ok: true, allowlisted?: string} | {ok: false, reason: string}} Verdict
 */

/** @param {RequestInfo["body"]} body */
const toBuffer = (body) => {
  if (body === null || body === undefined) {
    return Buffer.alloc(0);
  }

  return typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
};

/** @param {string} url */
const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0];
  }
};

/**
 * Pure classifier.
 *
 * @param {RequestInfo} request
 * @param {{fixtureBuffers?: Array<Buffer | Uint8Array>}} [options]
 * @returns {Verdict}
 */
export const classifyRequest = (request, {fixtureBuffers = []} = {}) => {
  const method = request.method.toUpperCase();
  const body = toBuffer(request.body);

  if (body.includes(PNG_SIGNATURE)) {
    return {ok: false, reason: "request body contains a PNG signature"};
  }

  if (body.includes(JPEG_SIGNATURE)) {
    return {ok: false, reason: "request body contains a JPEG signature"};
  }

  for (const fixture of fixtureBuffers) {
    if (fixture.length > 0 && body.includes(fixture)) {
      return {ok: false, reason: "request body contains the bytes of a fixture"};
    }
  }

  if (SAFE_METHODS.has(method)) {
    return {ok: true};
  }

  const path = pathOf(request.url);
  const entry = ALLOWLIST.find(
    (candidate) =>
      candidate.method === method && path.endsWith(candidate.pathSuffix),
  );

  if (!entry) {
    return {
      ok: false,
      reason: `${method} is not allowed (only the Remotion register-usage-point telemetry POST is)`,
    };
  }

  if (body.length > entry.maxBytes) {
    return {
      ok: false,
      reason: `${entry.name} body is ${body.length} bytes, over the ${entry.maxBytes}-byte limit`,
    };
  }

  return {ok: true, allowlisted: entry.name};
};

/** @param {string} url */
const stripQuery = (url) => url.replace(/[?#].*$/, "");

/** @param {string} url */
const hostOf = (url) => {
  try {
    const parsed = new URL(url);

    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.host
      : "";
  } catch {
    return "";
  }
};

/**
 * Observes every request of the context (all its pages, present and future).
 *
 * @param {Pick<import("@playwright/test").BrowserContext, "on">} context
 * @param {{fixtureBuffers?: Array<Buffer | Uint8Array>}} [options]
 */
export const attachNetworkGuard = (context, {fixtureBuffers = []} = {}) => {
  /** @type {string[]} */
  const violations = [];
  /** @type {Array<Record<string, unknown>>} */
  const log = [];
  /** @type {Set<string>} */
  const hosts = new Set();

  context.on("request", (request) => {
    try {
      const method = request.method();
      const url = request.url();
      let body = null;

      try {
        body = request.postDataBuffer();
      } catch {
        // An unreadable body is treated as empty; the method rule still applies.
      }

      const host = hostOf(url);
      const verdict = classifyRequest({method, url, body}, {fixtureBuffers});

      if (host) {
        hosts.add(host);
      }

      if (verdict.ok && method.toUpperCase() === "GET") {
        return;
      }

      const entry = {
        method: method.toUpperCase(),
        url: stripQuery(url),
        host,
        bytes: toBuffer(body).length,
        ...(verdict.ok
          ? {allowlisted: verdict.allowlisted}
          : {violation: verdict.reason}),
      };

      log.push(entry);

      if (!verdict.ok) {
        violations.push(`${entry.method} ${entry.url}: ${verdict.reason}`);
      }
    } catch (error) {
      // The listener must never throw into Playwright; fail loudly instead.
      violations.push(`network guard error: ${String(error)}`);
    }
  });

  return {
    violations: () => [...violations],
    log: () => log.map((entry) => ({...entry})),
    hosts: () => [...hosts].sort(),
  };
};

/**
 * Merges one guard's log under `label` into artifacts/network.json.
 *
 * @param {string} networkPath
 * @param {string} label  for example "A:gate" or "B:build-identity"
 * @param {ReturnType<typeof attachNetworkGuard>} guard
 */
export const saveNetworkLog = async (networkPath, label, guard) => {
  /** @type {Record<string, unknown>} */
  let saved = {};

  try {
    saved = JSON.parse(await readFile(networkPath, "utf8"));
  } catch {
    // First write.
  }

  saved[label] = {
    log: guard.log(),
    hosts: guard.hosts(),
    violations: guard.violations(),
  };
  await mkdir(dirname(networkPath), {recursive: true});
  await writeFile(networkPath, `${JSON.stringify(saved, null, 2)}\n`);
};

/**
 * One line for a report detail.
 *
 * @param {ReturnType<typeof attachNetworkGuard>} guard
 */
export const summarizeNetwork = (guard) => {
  const log = guard.log();
  const posts = log.filter((entry) => entry.method !== "GET");

  return `${posts.length} non-GET request(s)${
    posts.length > 0
      ? ` (${posts.map((entry) => `${entry.method} ${entry.url}, ${entry.bytes} B`).join("; ")})`
      : ""
  }; hosts: ${guard.hosts().join(", ") || "none"}; ${guard.violations().length} violation(s)`;
};
