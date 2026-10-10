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
//
// Deploy Preview drawer (ruling R10): Netlify injects its drawer into Deploy
// Preview pages, and the drawer POSTs session and view telemetry. Those two
// POSTs are allowed only when the caller says the page under test is a build
// whose context is not "production" (allowPreviewDrawer). The image and
// fixture signature checks still apply to them.

import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname} from "node:path";

export const TELEMETRY_MAX_BYTES = 4096;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

// R10: exact host and path of the two Deploy Preview drawer POSTs observed on
// PR #28's preview (518 B and 663 B bodies, no user data).
const BUGSNAG_SESSIONS_HOST = "sessions.bugsnag.com";
const BUGSNAG_SESSIONS_PATH = "/";
const NETLIFY_DRAWER_HOST = "app.netlify.com";
const NETLIFY_DRAWER_VIEWS_PATH =
  /^\/access-control\/bb-api\/api\/v1\/cdp\/deploys\/[0-9a-f]+\/views$/u;

/**
 * @typedef {{
 *   name: string,
 *   method: string,
 *   maxBytes: number,
 *   previewDrawer?: boolean,
 *   matches: (target: {protocol: string, host: string, path: string}) => boolean,
 * }} AllowlistEntry
 */

/** @type {AllowlistEntry[]} */
const ALLOWLIST = [
  {
    // Remotion licence telemetry, sent for each browser render. Ruled in
    // ASSET-006 Part B (0.2 kB, no user data).
    name: "remotion-register-usage-point",
    method: "POST",
    matches: ({path}) => path.endsWith("/register-usage-point"),
    maxBytes: TELEMETRY_MAX_BYTES,
  },
  {
    // R10: Deploy Preview drawer, Bugsnag session ping.
    name: "preview-drawer-bugsnag-sessions",
    method: "POST",
    matches: ({protocol, host, path}) =>
      protocol === "https:" &&
      host === BUGSNAG_SESSIONS_HOST &&
      path === BUGSNAG_SESSIONS_PATH,
    maxBytes: TELEMETRY_MAX_BYTES,
    previewDrawer: true,
  },
  {
    // R10: Deploy Preview drawer, Netlify deploy view ping.
    name: "preview-drawer-netlify-views",
    method: "POST",
    matches: ({protocol, host, path}) =>
      protocol === "https:" &&
      host === NETLIFY_DRAWER_HOST &&
      NETLIFY_DRAWER_VIEWS_PATH.test(path),
    maxBytes: TELEMETRY_MAX_BYTES,
    previewDrawer: true,
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
const targetOf = (url) => {
  try {
    const parsed = new URL(url);

    return {
      protocol: parsed.protocol,
      host: parsed.hostname,
      path: parsed.pathname,
    };
  } catch {
    return {protocol: "", host: "", path: url.split(/[?#]/)[0]};
  }
};

/**
 * Pure classifier.
 *
 * @param {RequestInfo} request
 * @param {{fixtureBuffers?: Array<Buffer | Uint8Array>, allowPreviewDrawer?: boolean}} [options]
 *   `allowPreviewDrawer` (R10) enables the two Deploy Preview drawer POSTs; it
 *   must be true only for a page whose build context is known and is not
 *   "production".
 * @returns {Verdict}
 */
export const classifyRequest = (
  request,
  {fixtureBuffers = [], allowPreviewDrawer = false} = {},
) => {
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

  const target = targetOf(request.url);
  const entry = ALLOWLIST.find(
    (candidate) =>
      candidate.method === method &&
      (allowPreviewDrawer || !candidate.previewDrawer) &&
      candidate.matches(target),
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
 * `allowPreviewDrawer` (R10) is a boolean or a function returning one. A
 * function is read when violations() or log() is called, not when the request
 * is seen, so a spec that only learns the build context after the page loaded
 * (the build-identity spec) still judges the drawer POSTs by that context.
 *
 * @param {Pick<import("@playwright/test").BrowserContext, "on">} context
 * @param {{
 *   fixtureBuffers?: Array<Buffer | Uint8Array>,
 *   allowPreviewDrawer?: boolean | (() => boolean),
 * }} [options]
 */
export const attachNetworkGuard = (
  context,
  {fixtureBuffers = [], allowPreviewDrawer = false} = {},
) => {
  /** @type {string[]} */
  const errors = [];
  /** @type {Array<{method: string, url: string, host: string, bytes: number, strict: Verdict, lenient: Verdict}>} */
  const records = [];
  /** @type {Set<string>} */
  const hosts = new Set();
  const drawerAllowed = () =>
    (typeof allowPreviewDrawer === "function"
      ? allowPreviewDrawer()
      : allowPreviewDrawer) === true;

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
      const strict = classifyRequest(
        {method, url, body},
        {fixtureBuffers, allowPreviewDrawer: false},
      );
      const lenient = classifyRequest(
        {method, url, body},
        {fixtureBuffers, allowPreviewDrawer: true},
      );

      if (host) {
        hosts.add(host);
      }

      if (strict.ok && method.toUpperCase() === "GET") {
        return;
      }

      records.push({
        method: method.toUpperCase(),
        url: stripQuery(url),
        host,
        bytes: toBuffer(body).length,
        strict,
        lenient,
      });
    } catch (error) {
      // The listener must never throw into Playwright; fail loudly instead.
      errors.push(`network guard error: ${String(error)}`);
    }
  });

  const entries = () => {
    const lenient = drawerAllowed();

    return records.map(({strict, lenient: relaxed, ...entry}) => {
      const verdict = lenient ? relaxed : strict;

      return {
        ...entry,
        ...(verdict.ok
          ? {allowlisted: verdict.allowlisted}
          : {violation: verdict.reason}),
      };
    });
  };

  return {
    violations: () => [
      ...entries()
        .filter((entry) => "violation" in entry)
        .map((entry) => `${entry.method} ${entry.url}: ${entry.violation}`),
      ...errors,
    ],
    log: () => entries(),
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
 * One line for a report detail. `drawerContext` (R10) is the build context
 * when the drawer POSTs were allowed for this guard; the line then says so.
 *
 * @param {Pick<ReturnType<typeof attachNetworkGuard>, "log" | "hosts" | "violations">} guard
 * @param {{drawerContext?: string | null}} [options]
 */
export const summarizeNetwork = (guard, {drawerContext = null} = {}) => {
  const posts = guard.log().filter((entry) => entry.method !== "GET");
  const groups = new Map();

  for (const entry of posts) {
    const label = `${entry.method} ${entry.url}, ${entry.bytes} B`;

    groups.set(label, (groups.get(label) ?? 0) + 1);
  }

  const detail = [...groups]
    .map(([label, count]) => (count > 1 ? `${count} x ${label}` : label))
    .join("; ");

  const drawer = drawerContext
    ? `; Deploy Preview drawer POSTs allowed (context ${drawerContext})`
    : "";

  return `${posts.length} non-GET request(s)${detail ? ` (${detail})` : ""}; hosts: ${guard.hosts().join(", ") || "none"}; ${guard.violations().length} violation(s)${drawer}`;
};

/**
 * One guard over several contexts (a browser relaunched with the same profile
 * is a new context). `guards` may be extended after the call.
 *
 * @param {Array<ReturnType<typeof attachNetworkGuard>>} guards
 */
export const combineGuards = (guards) => ({
  violations: () => guards.flatMap((guard) => guard.violations()),
  log: () => guards.flatMap((guard) => guard.log()),
  hosts: () => [...new Set(guards.flatMap((guard) => guard.hosts()))].sort(),
});
