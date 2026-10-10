// GATE-001 G1, gate side: read the <meta name="tora-build"> identity that
// vite.config.mts injects at build time.

/**
 * @typedef {{commit: string, deployId: string, context: string}} BuildIdentity
 */

/** @param {BuildIdentity} identity */
export const formatIdentity = ({commit, deployId, context}) =>
  `${commit}/${deployId}/${context}`;

/**
 * R10: whether the network guard may allow Netlify's Deploy Preview drawer
 * POSTs. True only when the build context is known and is not "production"
 * (the local target's "local" counts, but the drawer never appears there).
 *
 * @param {Partial<BuildIdentity> | null | undefined} identity
 */
export const allowsPreviewDrawer = (identity) =>
  typeof identity?.context === "string" &&
  identity.context.length > 0 &&
  identity.context !== "production";

/**
 * @param {string | null | undefined} content
 * @returns {BuildIdentity}
 */
export const parseBuildIdentity = (content) => {
  const parts = typeof content === "string" ? content.split("/") : [];

  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error(
      `Malformed tora-build meta content ${JSON.stringify(content)}; expected "<commit>/<deployId>/<context>".`,
    );
  }

  const [commit, deployId, context] = parts;

  return {commit, deployId, context};
};

/**
 * Reads the identity of the build the page is running. Throws a clear error
 * when the meta is absent (a deploy that predates GATE-001).
 *
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<BuildIdentity>}
 */
export const readPageBuildIdentity = async (page) => {
  const content = await page.evaluate(
    () =>
      document
        .querySelector('meta[name="tora-build"]')
        ?.getAttribute("content") ?? null,
  );

  if (content === null) {
    throw new Error(
      `${page.url()} has no <meta name="tora-build">: the deployed build predates the GATE-001 build identity (G1). Deploy a build that includes it, then run the gate again.`,
    );
  }

  return parseBuildIdentity(content);
};
