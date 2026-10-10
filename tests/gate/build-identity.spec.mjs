import {expect, test} from "@playwright/test";
import {formatIdentity, readPageBuildIdentity} from "./helpers/buildIdentity.mjs";
import {mergePhase, readGateEnv, readState, statePaths} from "./helpers/gateState.mjs";
import {attachNetworkGuard, saveNetworkLog} from "./helpers/networkGuard.mjs";

// GATE-001 T1: prove which build the suite is testing. Opens the target, reads
// <meta name="tora-build"> (G1) and records it into state.json as a.identity
// (phase A) or b.identity (phase B). The "Deploy B is not live yet" comparison
// is the gate spec's job (assertNewBuild in helpers/gateState.mjs); this spec
// only exposes both identities.

const gate = readGateEnv();

test(`phase ${gate.phase}: records the deployed build identity`, async ({
  browser,
  context,
  page,
}) => {
  const guard = attachNetworkGuard(context);

  await page.goto("/", {waitUntil: "load"});

  const identity = await readPageBuildIdentity(page);

  await mergePhase(gate.stateDir, gate.phase, {
    identity,
    browser: {name: "Chrome", version: browser.version()},
  });

  const state = await readState(gate.stateDir);

  test.info().annotations.push({
    type: "build-identity",
    description:
      gate.phase === "B" && state.a.identity
        ? `A ${formatIdentity(state.a.identity)} -> B ${formatIdentity(identity)}`
        : `${gate.phase} ${formatIdentity(identity)}`,
  });

  await saveNetworkLog(
    statePaths(gate.stateDir).networkPath,
    `${gate.phase}:build-identity`,
    guard,
  );
  expect(guard.violations()).toEqual([]);
});
