// GATE-001 G2: deployed verification runner.
//
//   npm run gate -- --url=<prod|preview:<n>|local|https://origin> --phase=<A|B> [--headed] [--only=<grep>]
//
// Sets the gate environment, runs `playwright test --config=playwright.gate.config.mjs`
// (through process.execPath, no bare npx), then merges the optional Netlify API
// check (G8) into state and renders .gate/<target>/report.md. Exits with
// Playwright's code (or 1 when the Netlify check fails).

import {spawn} from "node:child_process";
import console from "node:console";
import {createRequire} from "node:module";
import {dirname, resolve} from "node:path";
import process from "node:process";
import {fileURLToPath, pathToFileURL} from "node:url";
import {
  mergePhase,
  readState,
  recordNetlify,
  startPhaseA,
  startPhaseB,
  statePaths,
  targetDir,
} from "../tests/gate/helpers/gateState.mjs";
import {writeReport} from "../tests/gate/helpers/report.mjs";
import {checkNetlifyDeploy} from "./gateNetlify.mjs";
import {
  buildGateEnv,
  parseGateArgs,
  resolveTarget,
  USAGE,
} from "./gateTarget.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYWRIGHT_CLI = createRequire(import.meta.url).resolve(
  "@playwright/test/cli",
);

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
const runPlaywright = (args, env) =>
  new Promise((resolveRun) => {
    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, ...args], {
      cwd: ROOT,
      env,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      console.error(`Could not start Playwright: ${error.message}`);
      resolveRun(1);
    });
    child.on("exit", (code, signal) => resolveRun(code ?? (signal ? 1 : 0)));
  });

/** @param {string[]} argv */
export const main = async (argv) => {
  let args;
  let target;

  try {
    args = parseGateArgs(argv);
    target = resolveTarget(args.url);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : error}\n\n${USAGE}`);

    return 2;
  }

  const {phase} = args;
  const stateDir = targetDir(target.slug, ROOT);
  const paths = statePaths(stateDir);

  try {
    if (phase === "A") {
      await startPhaseA({stateDir, target: target.slug, url: target.url});
    } else {
      await startPhaseB({stateDir, url: target.url});
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);

    return 2;
  }

  console.log(`Gate: phase ${phase} against ${target.url} (state: ${stateDir})`);

  // The token is for this runner only; the browser specs never see it.
  const {NETLIFY_AUTH_TOKEN: token, ...inherited} = process.env;
  const playwrightArgs = [
    "test",
    "--config=playwright.gate.config.mjs",
    ...(args.only ? ["--grep", args.only] : []),
  ];
  const code = await runPlaywright(playwrightArgs, {
    ...inherited,
    ...buildGateEnv({target, phase, headed: args.headed, stateDir}),
  });

  let netlifyFailed = false;

  try {
    await mergePhase(stateDir, phase, {finishedAt: new Date().toISOString()});

    const state = await readState(stateDir);
    const result = target.local
      ? {status: /** @type {const} */ ("skip"), detail: "not applicable to a local target"}
      : await checkNetlifyDeploy({
          token,
          identity: state[phase === "A" ? "a" : "b"]?.identity,
          isProduction: target.name === "prod",
        });

    await recordNetlify(stateDir, phase, result);
    netlifyFailed = result.status === "fail";
    console.log(
      result.status === "manual"
        ? "Netlify check: manual (no token)"
        : `Netlify check (phase ${phase}): ${result.status}. ${result.detail}`,
    );
    await writeReport(stateDir);
    console.log(`Report: ${paths.reportPath}`);
  } catch (error) {
    console.error(
      `Could not finish the report: ${error instanceof Error ? error.message : error}`,
    );

    return code || 1;
  }

  return code || (netlifyFailed ? 1 : 0);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
