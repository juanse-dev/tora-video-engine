import {execFileSync} from "node:child_process";
import {defineConfig, type Plugin} from "vite";

// GATE-001 G1: every build carries its identity as
// <meta name="tora-build" content="<commit>/<deployId>/<context>">, so the
// deployed-verification suite can prove which deploy it tested without opening
// Netlify. On Netlify the values are the build env COMMIT_REF, DEPLOY_ID and
// CONTEXT; locally they are the short git HEAD, local-<epoch ms> and "local".
// None of them is secret.

export type BuildIdentity = {
  commit: string;
  deployId: string;
  context: string;
};

type ResolveOptions = {
  env?: NodeJS.ProcessEnv;
  now?: number;
  gitCommit?: () => string | null;
};

const gitShortHead = (): string | null => {
  try {
    return (
      execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
};

// The content is "/"-separated and lands in an HTML attribute: keep it to a
// conservative alphabet so neither can be broken by an odd env value.
const clean = (value: string | undefined): string =>
  (value ?? "").trim().replace(/[^A-Za-z0-9._-]/g, "-");

export const resolveBuildIdentity = ({
  env = process.env,
  now = Date.now(),
  gitCommit = gitShortHead,
}: ResolveOptions = {}): BuildIdentity => ({
  commit: clean(env.COMMIT_REF) || clean(gitCommit() ?? "") || "unknown",
  deployId: clean(env.DEPLOY_ID) || `local-${now}`,
  context: clean(env.CONTEXT) || "local",
});

export const formatBuildIdentity = ({
  commit,
  deployId,
  context,
}: BuildIdentity): string => `${commit}/${deployId}/${context}`;

export const buildIdentityPlugin = (identity: BuildIdentity): Plugin => ({
  name: "tora-build-identity",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: {name: "tora-build", content: formatBuildIdentity(identity)},
      injectTo: "head",
    },
  ],
});

export default defineConfig({
  base: "/",
  plugins: [buildIdentityPlugin(resolveBuildIdentity())],
  build: {
    outDir: "dist/web",
  },
});
