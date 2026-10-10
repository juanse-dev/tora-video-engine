import {createRequire} from "node:module";
import {dirname, join} from "node:path";
import {defineConfig} from "@playwright/test";
import {readGateEnv} from "./tests/gate/helpers/gateState.mjs";

// GATE-001 G3. Run through `npm run gate -- --url=<target> --phase=<A|B>`,
// which sets the environment read here (a bare `playwright test --config=...`
// fails with a message saying so).
//
// Only the `local` target starts a server: phase A builds dist/web and serves
// it with vite preview; phase B builds an unminified copy into
// dist/web-gate-b (a genuinely different build, new local-<epoch> deploy id)
// and serves that on the same port, so the origin and the profile stay the
// same. Deployed targets are never built or served from here.
const gate = readGateEnv();
const LOCAL_PORT = 4190;
const viteCli = join(
  dirname(createRequire(import.meta.url).resolve("vite/package.json")),
  "bin",
  "vite.js",
);
const node = `"${process.execPath}"`;
const vite = `"${viteCli}"`;
const preview = `preview --host 127.0.0.1 --port ${LOCAL_PORT} --strictPort`;

const localServer = () => {
  const outDir = gate.phase === "A" ? "dist/web" : "dist/web-gate-b";
  const build =
    gate.phase === "A" ? "build" : `build --outDir ${outDir} --minify false`;

  return {
    command: `${node} ${vite} ${build} && ${node} ${vite} ${preview} --outDir ${outDir}`,
    url: `http://127.0.0.1:${LOCAL_PORT}/index.html`,
    reuseExistingServer: false,
    timeout: 180_000,
  };
};

export default defineConfig({
  testDir: "tests/gate",
  // Failure traces and screenshots stay in the git-ignored state dir (and
  // apart from artifacts/, which Playwright would clean).
  outputDir: join(gate.stateDir, "test-results"),
  // One run drives real renders; generous per-test budget, one test at a time.
  timeout: 600_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: gate.url,
    // H.264 encoding needs real Chrome, same as the persistence spec.
    channel: "chrome",
    headless: !gate.headed,
  },
  ...(gate.local ? {webServer: localServer()} : {}),
});
