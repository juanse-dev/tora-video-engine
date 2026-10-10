// GATE-001 G8: optional read-only Netlify API check, run by scripts/gate.mjs
// (never from the browser) when NETLIFY_AUTH_TOKEN is set.
//
//   GET https://api.netlify.com/api/v1/sites/tora-video-engine.netlify.app
//   GET https://api.netlify.com/api/v1/deploys/<deployId from the page's build identity>
//
// It asserts the deploy is "ready", that its commit_ref matches the page's
// commit and, for production, that it is the site's published deploy. It also
// records whether the deploy has Functions. It only ever issues GET, and the
// token never leaves the Authorization header (it is not in any result).

import {URL} from "node:url";

export const NETLIFY_API = "https://api.netlify.com/api/v1";
export const NETLIFY_SITE = "tora-video-engine.netlify.app";

/**
 * @typedef {import("../tests/gate/helpers/buildIdentity.mjs").BuildIdentity} BuildIdentity
 * @typedef {import("../tests/gate/helpers/report.mjs").NetlifyResult} NetlifyResult
 */

class NetlifyApiError extends Error {}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} token
 * @param {string} path
 */
const getJson = async (fetchImpl, token, path) => {
  const response = await fetchImpl(`${NETLIFY_API}${path}`, {
    method: "GET",
    headers: {Authorization: `Bearer ${token}`, Accept: "application/json"},
    signal: globalThis.AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? " (check NETLIFY_AUTH_TOKEN)"
        : "";

    throw new NetlifyApiError(
      `GET ${path} returned ${response.status}${hint}`,
    );
  }

  return response.json();
};

/**
 * @param {string} actual  the deploy's full commit_ref
 * @param {string} page  the page's commit (full or short)
 */
const sameCommit = (actual, page) => {
  const a = String(actual ?? "").toLowerCase();
  const b = String(page ?? "").toLowerCase();

  return a !== "" && b !== "" && b !== "unknown" && (a.startsWith(b) || b.startsWith(a));
};

const countFunctions = (/** @type {any} */ deploy) =>
  Math.max(
    Array.isArray(deploy.available_functions) ? deploy.available_functions.length : 0,
    Array.isArray(deploy.functions) ? deploy.functions.length : 0,
  );

/**
 * @param {{
 *   token?: string,
 *   identity?: BuildIdentity,
 *   isProduction: boolean,
 *   fetch?: typeof fetch,
 * }} options
 * @returns {Promise<NetlifyResult>}
 */
export const checkNetlifyDeploy = async ({
  token,
  identity,
  isProduction,
  fetch: fetchImpl = globalThis.fetch,
}) => {
  if (!token || token.trim() === "") {
    return {status: "manual", detail: "manual (no token)"};
  }

  if (!identity) {
    return {
      status: "skip",
      detail: "no build identity was recorded for this phase, so there is no deploy to look up",
    };
  }

  if (identity.deployId.startsWith("local-")) {
    return {
      status: "fail",
      detail: `deploy id ${identity.deployId} is not a Netlify deploy (it looks like a local build)`,
    };
  }

  try {
    const site = await getJson(
      fetchImpl,
      token.trim(),
      `/sites/${encodeURIComponent(NETLIFY_SITE)}`,
    );
    const deploy = await getJson(
      fetchImpl,
      token.trim(),
      `/deploys/${encodeURIComponent(identity.deployId)}`,
    );
    /** @type {Array<{name: string, ok: boolean, detail: string}>} */
    const checks = [
      {
        name: "deploy state is ready",
        ok: deploy.state === "ready",
        detail:
          deploy.state === "ready"
            ? "deploy ready"
            : `deploy state is "${deploy.state}", not ready`,
      },
      {
        name: "commit matches the page",
        ok: sameCommit(deploy.commit_ref, identity.commit),
        detail: sameCommit(deploy.commit_ref, identity.commit)
          ? "commit matches the page"
          : `commit mismatch: Netlify commit_ref ${deploy.commit_ref ?? "none"}, page commit ${identity.commit}`,
      },
    ];

    if (isProduction) {
      const publishedId = site.published_deploy?.id;
      const published = publishedId === deploy.id && Boolean(deploy.id);

      checks.push({
        name: "deploy is the published production deploy",
        ok: published,
        detail: published
          ? "published production deploy"
          : `deploy is not the published deploy (published: ${publishedId ?? "none"})`,
      });
    }

    const functions = countFunctions(deploy);
    const functionsText = `Functions: ${functions === 0 ? "none" : functions}`;
    const failed = checks.filter(({ok}) => !ok);

    return {
      status: failed.length === 0 ? "pass" : "fail",
      detail: `${(failed.length === 0 ? checks : failed).map(({detail}) => detail).join("; ")}; ${functionsText}`,
      checks,
    };
  } catch (error) {
    return {
      status: "fail",
      detail:
        error instanceof NetlifyApiError
          ? error.message
          : `Netlify API request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/**
 * Whether the check applies to a target at all. Returns null when it does, or
 * the "skip" result to record when it does not (a local target, or a host that
 * is not a Netlify site, which would otherwise always fail the commit check).
 *
 * @param {{url: string, local: boolean}} target
 * @returns {NetlifyResult | null}
 */
export const netlifyApplicability = ({url, local}) => {
  if (local) {
    return {status: "skip", detail: "not applicable to a local target"};
  }

  let host = "";

  try {
    host = new URL(url).hostname;
  } catch {
    // Falls through to "not a Netlify site".
  }

  return host.endsWith(".netlify.app")
    ? null
    : {status: "skip", detail: "not a Netlify site"};
};
