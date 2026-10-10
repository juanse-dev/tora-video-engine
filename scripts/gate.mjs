// GATE-001 G2: deployed verification runner.
//
//   npm run gate -- --url=<prod|preview:<n>|local|https://origin> --phase=<A|B> [--headed] [--only=<grep>]
//
// Sets the gate environment, runs `playwright test --config=playwright.gate.config.mjs`
// (through process.execPath, no bare npx), then merges the optional Netlify API
// check (G8) into state and renders .gate/<target>/report.md. Exits with
// Playwright's code, or 1 when the Netlify check fails: with NETLIFY_AUTH_TOKEN
// set, a failing check makes the exit code 1 even if every test passed. The
// check only runs for *.netlify.app targets; other hosts record "skip".
//
// A non-zero Playwright exit is stored in state (exitCode plus the first lines
// of the failure) so the report lists it and its verdict is FAIL, even when no
// spec recorded a result.

import {spawn} from "node:child_process";
import console from "node:console";
import {realpathSync} from "node:fs";
import {createRequire} from "node:module";
import {dirname, resolve} from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
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
import {checkNetlifyDeploy, netlifyApplicability} from "./gateNetlify.mjs";
import {summarizePlaywrightOutput} from "./gateSummary.mjs";
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

const OUTPUT_TAIL_BYTES = 200_000;

/**
 * Runs Playwright, echoing its output and keeping the tail of it.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{code: number, output: string}>}
 */
const runPlaywright = (args, env) =>
  new Promise((resolveRun) => {
    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, ...args], {
      cwd: ROOT,
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let output = "";
    const keep = (/** @type {Buffer} */ chunk) => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL_BYTES);
    };

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      keep(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      keep(chunk);
    });

    child.on("error", (error) => {
      console.error(`Could not start Playwright: ${error.message}`);
      resolveRun({code: 1, output: output || error.message});
    });
    child.on("close", (code, signal) =>
      resolveRun({code: code ?? (signal ? 1 : 0), output}),
    );
  });

/** @param {string[]} argv */
export const main = async (argv) => {
  let args;
  let target;
  let stateDir;

  try {
    args = parseGateArgs(argv);
    target = resolveTarget(args.url);
    stateDir = targetDir(target.slug, ROOT);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : error}\n\n${USAGE}`);

    return 2;
  }

  const {phase} = args;
  const paths = statePaths(stateDir);

  try {
    if (phase === "A") {
      await startPhaseA({
        stateDir,
        target: target.slug,
        url: target.url,
        fresh: args.fresh,
        root: ROOT,
      });
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
  const {code, output} = await runPlaywright(playwrightArgs, {
    ...inherited,
    ...buildGateEnv({target, phase, headed: args.headed, stateDir}),
  });

  let netlifyFailed = false;

  try {
    await mergePhase(stateDir, phase, {
      finishedAt: new Date().toISOString(),
      exitCode: code,
      ...(code !== 0
        ? {playwrightSummary: summarizePlaywrightOutput(output)}
        : {}),
    });

    const state = await readState(stateDir);
    const result =
      netlifyApplicability(target) ??
      (await checkNetlifyDeploy({
          token,
          identity: state[phase === "A" ? "a" : "b"]?.identity,
          isProduction: target.name === "prod",
        }));

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

/**
 * True when this file is the program being run. Both sides go through
 * realpath: Node resolves the main module's symlinks, but argv[1] keeps the
 * path as typed, so a run through a junction or symlink would otherwise match
 * nothing and exit 0 silently.
 *
 * @param {string} moduleUrl
 * @param {string | undefined} entryPath
 */
export const isEntryPoint = (moduleUrl, entryPath) => {
  if (!entryPath) {
    return false;
  }

  try {
    return (
      realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(entryPath))
    );
  } catch {
    return false;
  }
};

if (isEntryPoint(import.meta.url, process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
