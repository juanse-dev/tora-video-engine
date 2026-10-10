import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, it} from "node:test";
import {
  GOLDEN_ITEMS,
  phaseOutcome,
  renderReport,
} from "./gate/helpers/report.mjs";
import {
  assertPhaseAPassed,
  phaseAIncompleteReason,
  readState,
  recordFailureOf,
  startPhaseA,
  startPhaseB,
  targetDir,
  writeState,
} from "./gate/helpers/gateState.mjs";

// R11: one source of truth for "phase X passed". The report verdict, the
// phase B precondition and the phase A `--fresh` guard all read phaseOutcome.

const URL_A = "https://tora-video-engine.netlify.app";
const POSE = "local:pose:sha256:aa";
const BACKGROUND = "local:background:sha256:bb";

/** A state.json after a complete, passing phase A. */
const passedA = () => ({
  version: 1,
  target: "prod",
  url: URL_A,
  a: {
    startedAt: "2026-10-10T10:00:00.000Z",
    finishedAt: "2026-10-10T10:05:00.000Z",
    exitCode: 0,
    identity: {commit: "d4aa69a", deployId: "6ac9d19a", context: "production"},
    browser: {name: "Chrome", version: "154.0.8037.98"},
    refs: {pose: POSE, background: BACKGROUND},
    reloadDetail: "Phase A pass.",
    profileMarker: "token",
    networkSummary: "0 non-GET request(s)",
  },
  results: {
    reload: {status: "pending", detail: "Phase A steps 2-6 pass.", phase: "A"},
    noUpload: {status: "pending", detail: "Phase A clean.", phase: "A"},
    cliParity: {status: "pass", detail: "360 frames.", phase: "A"},
    goldenNetwork: {status: "pass", detail: "clean", phase: "A"},
    ...Object.fromEntries(
      GOLDEN_ITEMS.map(({key}) => [key, {status: "pass", detail: "", phase: "A"}]),
    ),
  },
  netlify: {},
});

/** A state.json after a complete, passing phase A and phase B. */
const passedAB = () => {
  const state = passedA();

  state.b = {
    startedAt: "2026-10-10T12:00:00.000Z",
    finishedAt: "2026-10-10T12:03:00.000Z",
    exitCode: 0,
    identity: {commit: "da946d8", deployId: "6aca4836", context: "production"},
    browser: {name: "Chrome", version: "154.0.8037.98"},
  };
  state.results.reload = {status: "pass", detail: "A to B pass.", phase: "B"};
  state.results.noUpload = {status: "pass", detail: "clean", phase: "B"};
  state.results.deleteReimport = {status: "pass", detail: "recovered", phase: "B"};

  return state;
};

/** `--phase=A --only="phase A"`: no WEB-007 golden items were run. */
const withoutGolden = (state) => {
  for (const {key} of GOLDEN_ITEMS) {
    delete state.results[key];
  }

  delete state.results.goldenNetwork;

  return state;
};

/** `--phase=B --only=...`: only the build identity of phase B was recorded. */
const onlyBuildIdentityB = () => {
  const state = passedAB();

  delete state.results.deleteReimport;
  state.results.reload = {status: "pending", detail: "Phase A steps 2-6 pass.", phase: "A"};
  state.results.noUpload = {status: "pending", detail: "Phase A clean.", phase: "A"};

  return state;
};

const verdictOf = (state) =>
  /^Result: (.*)$/m.exec(renderReport(state, state.results))?.[1];

/**
 * [name, state, phase A passed, phase B passed, report verdict].
 * The report verdict must follow from the two outcomes in every row.
 */
const CASES = [
  ["a complete phase A", passedA(), true, false, "PHASE A PASSED (phase B pending)"],
  ["a complete phase A and phase B", passedAB(), true, true, "PASS"],
  [
    "phase A run with --only (golden items missing)",
    withoutGolden(passedA()),
    false,
    false,
    "INCOMPLETE",
  ],
  [
    "phase A with a failed Netlify check",
    Object.assign(passedA(), {netlify: {A: {status: "fail", detail: "commit mismatch"}}}),
    false,
    false,
    "FAIL",
  ],
  [
    "phase A with a skipped Netlify check",
    Object.assign(passedA(), {netlify: {A: {status: "skip", detail: "local"}}}),
    true,
    false,
    "PHASE A PASSED (phase B pending)",
  ],
  [
    "phase A with a manual Netlify check",
    Object.assign(passedA(), {netlify: {A: {status: "manual", detail: "no token"}}}),
    true,
    false,
    "PHASE A PASSED (phase B pending)",
  ],
  [
    "phase A with a Playwright exit code of 1",
    (() => {
      const state = passedA();

      state.a.exitCode = 1;

      return state;
    })(),
    false,
    false,
    "FAIL",
  ],
  [
    "phase A that never finished",
    (() => {
      const state = passedA();

      delete state.a.finishedAt;

      return state;
    })(),
    false,
    false,
    "INCOMPLETE",
  ],
  [
    "phase A with a failing golden item",
    (() => {
      const state = passedA();

      state.results["golden.poseChange"] = {status: "fail", detail: "x", phase: "A"};

      return state;
    })(),
    false,
    false,
    "FAIL",
  ],
  [
    "phase A with a failed golden network guard",
    (() => {
      const state = passedA();

      state.results.goldenNetwork = {status: "fail", detail: "POST /x", phase: "A"};

      return state;
    })(),
    false,
    false,
    "FAIL",
  ],
  [
    "phase A with a skipped golden item (--only ran a subset)",
    (() => {
      const state = passedA();

      state.results["golden.sceneReorder"] = {
        status: "skip",
        detail: "not run (an earlier item failed or the run was interrupted)",
        phase: "A",
      };

      return state;
    })(),
    false,
    false,
    "INCOMPLETE",
  ],
  [
    "phase A with a pending CLI parity",
    (() => {
      const state = passedA();

      state.results.cliParity = {status: "pending", detail: "later", phase: "A"};

      return state;
    })(),
    false,
    false,
    "INCOMPLETE",
  ],
  [
    "phase A with a skipped golden network guard",
    (() => {
      const state = passedA();

      state.results.goldenNetwork = {status: "skip", detail: "x", phase: "A"};

      return state;
    })(),
    false,
    false,
    "INCOMPLETE",
  ],
  [
    "phase A whose reload and noUpload rows were overwritten or dropped by a phase B rerun",
    (() => {
      const state = passedA();

      delete state.results.reload;
      delete state.results.noUpload;

      return state;
    })(),
    true,
    false,
    "PHASE A PASSED (phase B pending)",
  ],
  [
    "phase B run with --only (only the build identity recorded)",
    onlyBuildIdentityB(),
    true,
    false,
    "INCOMPLETE",
  ],
  [
    "phase B with a failed Netlify check",
    Object.assign(passedAB(), {
      netlify: {
        A: {status: "pass", detail: "ok"},
        B: {status: "fail", detail: "commit mismatch"},
      },
    }),
    true,
    false,
    "FAIL",
  ],
  [
    "phase B with a Playwright exit code of 1",
    (() => {
      const state = passedAB();

      state.b.exitCode = 1;

      return state;
    })(),
    true,
    false,
    "FAIL",
  ],
  [
    "phase B with a failed result",
    (() => {
      const state = passedAB();

      state.results.deleteReimport = {status: "fail", detail: "x", phase: "B"};

      return state;
    })(),
    true,
    false,
    "FAIL",
  ],
  [
    "phase B whose reload row is still the pending A half",
    (() => {
      const state = passedAB();

      state.results.reload = {status: "pending", detail: "A half", phase: "A"};

      return state;
    })(),
    true,
    false,
    "INCOMPLETE",
  ],
  [
    "phase B that never finished",
    (() => {
      const state = passedAB();

      delete state.b.finishedAt;

      return state;
    })(),
    true,
    false,
    "INCOMPLETE",
  ],
];

describe("GATE-001 R11 phaseOutcome", () => {
  for (const [name, state, passedForA, passedForB, verdict] of CASES) {
    it(`${name}: A passed ${passedForA}, B passed ${passedForB}, report ${verdict}`, () => {
      const outcomeA = phaseOutcome(state, "A");
      const outcomeB = phaseOutcome(state, "B");

      assert.equal(outcomeA.passed, passedForA, outcomeA.reasons.join("; "));
      assert.equal(outcomeB.passed, passedForB, outcomeB.reasons.join("; "));
      assert.equal(outcomeA.passed, outcomeA.reasons.length === 0);
      assert.equal(outcomeB.passed, outcomeB.reasons.length === 0);
      assert.equal(verdictOf(state), verdict);
    });

    it(`${name}: the report verdict follows from the two outcomes`, () => {
      const outcomeA = phaseOutcome(state, "A");
      const outcomeB = phaseOutcome(state, "B");
      const hasB = Boolean(state.b);
      const expected =
        outcomeA.failed || outcomeB.failed
          ? "FAIL"
          : !outcomeA.passed || (hasB && !outcomeB.passed)
            ? "INCOMPLETE"
            : hasB
              ? "PASS"
              : "PHASE A PASSED (phase B pending)";

      assert.equal(verdictOf(state), expected);
    });
  }

  it("names the missing phase A items", () => {
    const {reasons} = phaseOutcome(withoutGolden(passedA()), "A");
    const text = reasons.join("; ");

    for (const {key} of GOLDEN_ITEMS) {
      assert.ok(text.includes(key), `${key} in: ${text}`);
    }

    assert.match(text, /goldenNetwork/);
  });

  it("names the missing phase B items", () => {
    const text = phaseOutcome(onlyBuildIdentityB(), "B").reasons.join("; ");

    assert.match(text, /reload/);
    assert.match(text, /noUpload/);
    assert.match(text, /deleteReimport/);
  });

  it("requires status pass for cliParity, every golden item and goldenNetwork, naming the one that did not", () => {
    for (const key of ["cliParity", "goldenNetwork", ...GOLDEN_ITEMS.map(({key}) => key)]) {
      for (const status of ["skip", "pending"]) {
        const state = passedA();

        state.results[key] = {status, detail: "x", phase: "A"};

        const outcome = phaseOutcome(state, "A");

        assert.equal(outcome.passed, false, `${key} ${status}`);
        assert.equal(outcome.failed, false);
        assert.ok(
          outcome.reasons.some((reason) => reason.includes(`${key} is ${status}`)),
          outcome.reasons.join("; "),
        );
      }
    }
  });

  it("proves the A halves of reload and noUpload from state.a, not from the shared rows (R12)", () => {
    const state = passedA();

    delete state.results.reload;
    delete state.results.noUpload;
    assert.equal(phaseOutcome(state, "A").passed, true);

    delete state.a.reloadDetail;
    delete state.a.networkSummary;

    const text = phaseOutcome(state, "A").reasons.join("; ");

    assert.match(text, /reloadDetail/);
    assert.match(text, /networkSummary/);
  });

  it("requires cliParity", () => {
    for (const key of ["cliParity"]) {
      const state = passedA();

      delete state.results[key];

      const outcome = phaseOutcome(state, "A");

      assert.equal(outcome.passed, false, key);
      assert.match(outcome.reasons.join("; "), new RegExp(key));
    }
  });

  it("requires the phase A build identity", () => {
    const state = passedA();

    delete state.a.identity;

    assert.match(phaseOutcome(state, "A").reasons.join("; "), /identity/);
  });

  it("requires the phase B build identity", () => {
    const state = passedAB();

    delete state.b.identity;

    assert.match(phaseOutcome(state, "B").reasons.join("; "), /identity/);
  });

  it("does not pass a phase B that has not run", () => {
    const outcome = phaseOutcome(passedA(), "B");

    assert.equal(outcome.passed, false);
    assert.equal(outcome.failed, false);
    assert.match(outcome.reasons.join("; "), /phase B has not run/);
  });

  it("does not count a failure stamped for the other phase", () => {
    const state = passedAB();

    state.results.deleteReimport = {status: "fail", detail: "x", phase: "B"};

    assert.equal(phaseOutcome(state, "A").passed, true);
  });
});

describe("GATE-001 R11 the guards read phaseOutcome", () => {
  let root;
  let stateDir;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gate-outcome-"));
    stateDir = targetDir("prod", root);
  });

  afterEach(async () => {
    await rm(root, {recursive: true, force: true});
  });

  /** Writes `state` as the state.json of a phase A that just ran. */
  const seed = async (state) => {
    await startPhaseA({stateDir, target: "prod", url: URL_A});
    await writeFile(join(stateDir, "profile", "marker.txt"), "keep");
    await writeState(stateDir, state);
  };

  it("phaseAIncompleteReason / assertPhaseAPassed refuse the --only phase A, naming the missing items", () => {
    const state = withoutGolden(passedA());

    assert.match(phaseAIncompleteReason(state), /golden\.appLoads.*goldenNetwork/s);
    assert.throws(
      () => assertPhaseAPassed(state),
      /^Error: Phase A did not pass \(.*golden\.appLoads.*\); rerun phase A before phase B$/s,
    );
  });

  it("phaseAIncompleteReason / assertPhaseAPassed refuse a phase A with a failed Netlify check", () => {
    const state = passedA();

    state.netlify = {A: {status: "fail", detail: "commit mismatch"}};

    assert.match(phaseAIncompleteReason(state), /Netlify.*commit mismatch/);
    assert.throws(() => assertPhaseAPassed(state), /Phase A did not pass \(.*Netlify/);
  });

  it("phaseAIncompleteReason accepts a skipped or manual Netlify check", () => {
    for (const status of ["skip", "manual"]) {
      const state = passedA();

      state.netlify = {A: {status, detail: "x"}};

      assert.equal(phaseAIncompleteReason(state), null, status);
    }
  });

  it("startPhaseB refuses a phase A run with --only and changes nothing", async () => {
    await seed(withoutGolden(passedA()));

    await assert.rejects(
      startPhaseB({stateDir, url: URL_A}),
      /Phase A did not pass \(.*golden\.appLoads.*\); rerun phase A before phase B/s,
    );
    assert.equal((await readState(stateDir)).b, undefined);
  });

  it("startPhaseB refuses a phase A whose Netlify check failed", async () => {
    const state = passedA();

    state.netlify = {A: {status: "fail", detail: "commit mismatch"}};
    await seed(state);

    await assert.rejects(startPhaseB({stateDir, url: URL_A}), /Netlify/);
  });

  for (const key of ["reload", "noUpload"]) {
    it(`a phase B rerun still accepts phase A after an earlier B failed at ${key} (R12)`, async () => {
      await seed(passedA());
      await startPhaseB({stateDir, url: URL_A, now: "t1"});

      const phase = process.env.TORA_GATE_PHASE;

      process.env.TORA_GATE_PHASE = "B";

      try {
        await assert.rejects(
          recordFailureOf(
            stateDir,
            key,
            async () => {
              throw new Error("Deploy B is not live yet: still abc1234 / d1 (production)");
            },
            {label: "step 9"},
          ),
          /not live yet/,
        );
      } finally {
        if (phase === undefined) {
          delete process.env.TORA_GATE_PHASE;
        } else {
          process.env.TORA_GATE_PHASE = phase;
        }
      }

      assert.equal((await readState(stateDir)).results[key].status, "fail");

      const state = await startPhaseB({stateDir, url: URL_A, now: "t2"});

      assert.equal(state.results[key], undefined);
      assert.doesNotThrow(() => assertPhaseAPassed(state));
      const onDisk = await readState(stateDir);

      assert.doesNotThrow(() => assertPhaseAPassed(onDisk));
    });
  }

  it("startPhaseB accepts a complete phase A", async () => {
    await seed(passedA());

    const state = await startPhaseB({stateDir, url: URL_A, now: "t1"});

    assert.deepEqual(state.b, {startedAt: "t1"});
  });

  it("phase A still needs --fresh after a phase B run with --only", async () => {
    await seed(onlyBuildIdentityB());

    await assert.rejects(
      startPhaseA({stateDir, target: "prod", url: URL_A}),
      /phase B has not completed.*--fresh/is,
    );
    assert.equal(existsSync(join(stateDir, "profile", "marker.txt")), true);
  });

  it("phase A still needs --fresh after a phase B whose Netlify check failed", async () => {
    const state = passedAB();

    state.netlify = {
      A: {status: "pass", detail: "ok"},
      B: {status: "fail", detail: "commit mismatch"},
    };
    await seed(state);

    await assert.rejects(
      startPhaseA({stateDir, target: "prod", url: URL_A}),
      /--fresh/,
    );
    assert.equal(existsSync(join(stateDir, "profile", "marker.txt")), true);
  });

  it("phase A starts without --fresh after a complete passing A + B", async () => {
    await seed(passedAB());

    const state = await startPhaseA({stateDir, target: "prod", url: URL_A});

    assert.equal(state.b, undefined);
    assert.equal(existsSync(join(stateDir, "profile", "marker.txt")), false);
  });

  it("phase A with --fresh starts over a phase A that passed", async () => {
    await seed(passedA());

    const state = await startPhaseA({
      stateDir,
      target: "prod",
      url: URL_A,
      fresh: true,
    });

    assert.deepEqual(state.results, {});
  });

  it("an --only phase A does not open the A to B window, so the next phase A needs no --fresh", async () => {
    await seed(withoutGolden(passedA()));

    await assert.doesNotReject(
      startPhaseA({stateDir, target: "prod", url: URL_A}),
    );
  });
});
