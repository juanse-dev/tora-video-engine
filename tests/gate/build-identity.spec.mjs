import {expect, test} from "@playwright/test";
import {
  allowsPreviewDrawer,
  formatIdentity,
  readPageBuildIdentity,
} from "./helpers/buildIdentity.mjs";
import {
  mergePhase,
  readGateEnv,
  readState,
  recordFailureOf,
  recordResult,
  statePaths,
} from "./helpers/gateState.mjs";
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
  // R10: the context is only known once the page has loaded, so the guard
  // reads this flag when its verdicts are asked for, not per request.
  let drawerAllowed = false;
  const guard = attachNetworkGuard(context, {
    allowPreviewDrawer: () => drawerAllowed,
  });

  // Any failure here (missing meta, a guard violation, a timeout) is recorded
  // under "buildIdentity" so the report lists it, then rethrown.
  await recordFailureOf(gate.stateDir, "buildIdentity", async () => {
    await page.goto("/", {waitUntil: "load"});

    const identity = await readPageBuildIdentity(page);

    drawerAllowed = allowsPreviewDrawer(identity);

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
    const violations = guard.violations();

    if (violations.length > 0) {
      await recordResult(gate.stateDir, "buildIdentity", {
        status: "fail",
        detail: `Network guard: ${violations.length} violation(s): ${violations.join("; ")}`,
      });
    }

    expect(violations).toEqual([]);
  });
});
