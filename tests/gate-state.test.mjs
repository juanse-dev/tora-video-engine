import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, it} from "node:test";
import {
  assertInsideGateDir,
  assertNewBuild,
  assertPhaseAPassed,
  mergePhase,
  phaseAIncompleteReason,
  prepareProfileForPhaseB,
  previewDrawerContext,
  readGateEnv,
  readState,
  recordFailureOf,
  recordNetlify,
  recordResult,
  startPhaseA,
  startPhaseB,
  statePaths,
  targetDir,
} from "./gate/helpers/gateState.mjs";

const URL_A = "https://tora-video-engine.netlify.app";
const identity = (deployId) => ({
  commit: "abc1234",
  deployId,
  context: "production",
});
// What a passed phase A leaves in state.json (see phaseAIncompleteReason).
const finishedA = (deployId = "d1") => ({
  identity: identity(deployId),
  reloadDetail: "Phase A pass.",
  profileMarker: "token",
  networkSummary: "0 non-GET request(s)",
  finishedAt: "2026-10-10T10:05:00.000Z",
  exitCode: 0,
});

let root;
let stateDir;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gate-state-"));
  stateDir = targetDir("prod", root);
});

afterEach(async () => {
  await rm(root, {recursive: true, force: true});
});

describe("GATE-001 G4 state directory", () => {
  it("keeps state under .gate/<slug>", () => {
    assert.equal(stateDir, join(root, ".gate", "prod"));
    assert.deepEqual(statePaths(stateDir), {
      stateDir,
      profileDir: join(stateDir, "profile"),
      artifactsDir: join(stateDir, "artifacts"),
      statePath: join(stateDir, "state.json"),
      reportPath: join(stateDir, "report.md"),
      networkPath: join(stateDir, "artifacts", "network.json"),
      snapshotDir: join(stateDir, "profile-before-b"),
    });
  });

  it("phase A deletes and recreates the target dir", async () => {
    await mkdir(join(stateDir, "profile"), {recursive: true});
    await writeFile(join(stateDir, "profile", "stale.txt"), "old");
    await writeFile(join(stateDir, "state.json"), "{}");

    const state = await startPhaseA({
      stateDir,
      target: "prod",
      url: URL_A,
      now: "2026-10-10T00:00:00.000Z",
    });
    const paths = statePaths(stateDir);

    assert.equal(existsSync(join(paths.profileDir, "stale.txt")), false);
    assert.equal(existsSync(paths.profileDir), true);
    assert.equal(existsSync(paths.artifactsDir), true);
    assert.deepEqual(state, {
      version: 1,
      target: "prod",
      url: URL_A,
      a: {startedAt: "2026-10-10T00:00:00.000Z"},
      results: {},
      netlify: {},
    });
    assert.deepEqual(await readState(stateDir), state);
  });
});

describe("GATE-001 G4 phase B load", () => {
  it("fails fast with a clear message when phase A never ran", async () => {
    await assert.rejects(
      startPhaseB({stateDir, url: URL_A}),
      /Phase B needs phase A.*--phase=A/s,
    );
  });

  it("fails when phase A was for another URL", async () => {
    await startPhaseA({stateDir, target: "prod", url: URL_A});
    await mergePhase(stateDir, "A", {identity: identity("d1")});

    await assert.rejects(
      startPhaseB({stateDir, url: "https://other.example.com"}),
      /Phase A was run for https:\/\/tora-video-engine\.netlify\.app/,
    );
  });

  it("fails when phase A recorded no build identity", async () => {
    await startPhaseA({stateDir, target: "prod", url: URL_A});

    await assert.rejects(
      startPhaseB({stateDir, url: URL_A}),
      /did not record a build identity/,
    );
  });

  it("fails before changing anything when phase A did not pass", async () => {
    await startPhaseA({stateDir, target: "prod", url: URL_A});
    await mergePhase(stateDir, "A", {identity: identity("d1")});
    await recordResult(stateDir, "cliParity", {
      status: "fail",
      detail: "boom",
      phase: "A",
    });

    await assert.rejects(
      startPhaseB({stateDir, url: URL_A}),
      /Phase A did not pass \(.*reloadDetail.*cliParity.*\); rerun phase A before phase B/s,
    );
    assert.equal((await readState(stateDir)).b, undefined);
  });

  it("startPhaseB refuses a phase A that exited non-zero even with every field recorded", async () => {
    await startPhaseA({stateDir, target: "prod", url: URL_A});
    await mergePhase(stateDir, "A", {...finishedA("d1"), exitCode: 1});

    await assert.rejects(
      startPhaseB({stateDir, url: URL_A}),
      /Phase A did not pass \(Playwright exit code 1\); rerun phase A before phase B/,
    );
    assert.equal((await readState(stateDir)).b, undefined);
  });

  it("startPhaseB refuses a phase A that never finished", async () => {
    await startPhaseA({stateDir, target: "prod", url: URL_A});

    const {finishedAt, ...unfinished} = finishedA("d1");

    await mergePhase(stateDir, "A", unfinished);

    await assert.rejects(startPhaseB({stateDir, url: URL_A}), /finishedAt/);
    assert.equal((await readState(stateDir)).b, undefined);
  });

  it("starts B, keeps A and drops results and Netlify data of an earlier B run", async () => {
    await startPhaseA({stateDir, target: "prod", url: URL_A});
    await mergePhase(stateDir, "A", finishedA("d1"));
    await recordResult(stateDir, "reload", {
      status: "pass",
      detail: "ok",
      phase: "A",
    });
    await recordResult(stateDir, "deleteReimport", {
      status: "pass",
      detail: "old",
      phase: "B",
    });
    await recordNetlify(stateDir, "A", {status: "pass", detail: "a"});
    await startPhaseB({stateDir, url: URL_A, now: "t1"});
    await recordResult(stateDir, "deleteReimport", {
      status: "fail",
      detail: "stale",
      phase: "B",
    });
    await recordNetlify(stateDir, "B", {status: "fail", detail: "stale"});

    const state = await startPhaseB({stateDir, url: URL_A, now: "t2"});

    assert.deepEqual(state.a.identity, identity("d1"));
    assert.deepEqual(state.b, {startedAt: "t2"});
    assert.deepEqual(Object.keys(state.results), ["reload"]);
    assert.deepEqual(Object.keys(state.netlify), ["A"]);
  });
});

describe("GATE-001 state API for the specs", () => {
  beforeEach(async () => {
    await startPhaseA({stateDir, target: "prod", url: URL_A});
  });

  it("merges phase data without losing earlier fields", async () => {
    await mergePhase(stateDir, "A", {
      browser: {name: "Chrome", version: "154"},
    });
    await mergePhase(stateDir, "A", {identity: identity("d1")});

    const state = await readState(stateDir);

    assert.equal(state.a.browser.version, "154");
    assert.equal(state.a.identity.deployId, "d1");
    assert.ok(state.a.startedAt);
  });

  it("previewDrawerContext (R10) is the recorded context unless production or unknown", async () => {
    assert.equal(await previewDrawerContext(stateDir, "A"), null);

    await mergePhase(stateDir, "A", {
      identity: {commit: "abc1234", deployId: "d1", context: "deploy-preview"},
    });
    assert.equal(await previewDrawerContext(stateDir, "A"), "deploy-preview");
    assert.equal(await previewDrawerContext(stateDir, "B"), null);

    await mergePhase(stateDir, "A", {identity: identity("d1")});
    assert.equal(await previewDrawerContext(stateDir, "A"), null);
  });

  it("previewDrawerContext is null when there is no state yet", async () => {
    await rm(statePaths(stateDir).statePath);
    assert.equal(await previewDrawerContext(stateDir, "A"), null);
  });

  it("records results keyed by name and overwrites the same key", async () => {
    await recordResult(stateDir, "reload", {
      status: "pending",
      detail: "A ok",
      phase: "A",
    });
    await recordResult(stateDir, "reload", {
      status: "pass",
      detail: "all ok",
      phase: "B",
    });
    await recordResult(stateDir, "cliParity", {status: "fail", detail: "boom"});

    const {results} = await readState(stateDir);

    assert.deepEqual(results.reload, {
      status: "pass",
      detail: "all ok",
      phase: "B",
    });
    assert.equal(results.cliParity.status, "fail");
  });

  it("stamps the phase from TORA_GATE_PHASE when not given", async () => {
    const before = process.env.TORA_GATE_PHASE;

    process.env.TORA_GATE_PHASE = "A";
    try {
      await recordResult(stateDir, "reload", {status: "pass", detail: "ok"});
    } finally {
      if (before === undefined) delete process.env.TORA_GATE_PHASE;
      else process.env.TORA_GATE_PHASE = before;
    }

    assert.equal((await readState(stateDir)).results.reload.phase, "A");
  });

  it("rejects an unknown status", async () => {
    await assert.rejects(
      recordResult(stateDir, "reload", {status: "ok", detail: "x"}),
      /status/,
    );
  });

  it("stores the Netlify result per phase", async () => {
    await recordNetlify(stateDir, "A", {
      status: "manual",
      detail: "manual (no token)",
    });

    assert.equal((await readState(stateDir)).netlify.A.status, "manual");
  });

  it("serialises to valid JSON on disk", async () => {
    await recordResult(stateDir, "reload", {
      status: "pass",
      detail: "ok",
      phase: "A",
    });

    JSON.parse(await readFile(statePaths(stateDir).statePath, "utf8"));
  });
});

describe("GATE-001 G2/G4 assertNewBuild", () => {
  const stateA = {a: {identity: identity("d1")}};

  it("accepts a different build", () => {
    assert.doesNotThrow(() => assertNewBuild(stateA, identity("d2")));
  });

  it("fails with 'Deploy B is not live yet: still <identity>' when unchanged", () => {
    assert.throws(
      () => assertNewBuild(stateA, identity("d1")),
      new Error("Deploy B is not live yet: still abc1234/d1/production"),
    );
  });

  it("fails when phase A has no identity", () => {
    assert.throws(
      () => assertNewBuild({a: {}}, identity("d2")),
      /no build identity/,
    );
  });
});

describe("GATE-001 G3 readGateEnv", () => {
  const full = {
    TORA_GATE_URL: URL_A,
    TORA_GATE_TARGET: "prod",
    TORA_GATE_PHASE: "A",
    TORA_GATE_LOCAL: "0",
    TORA_GATE_HEADED: "1",
    TORA_GATE_STATE_DIR: "/x/.gate/prod",
  };

  it("reads the runner's environment", () => {
    assert.deepEqual(readGateEnv(full), {
      url: URL_A,
      target: "prod",
      phase: "A",
      local: false,
      headed: true,
      stateDir: "/x/.gate/prod",
    });
  });

  it("explains itself when the env is missing", () => {
    assert.throws(
      () => readGateEnv({}),
      /TORA_GATE_URL.*npm run gate -- --url=<target> --phase=<A\|B>/s,
    );
  });

  it("rejects a bad phase", () => {
    assert.throws(
      () => readGateEnv({...full, TORA_GATE_PHASE: "C"}),
      /TORA_GATE_PHASE/,
    );
  });
});

describe("GATE-001 recordFailureOf", () => {
  beforeEach(async () => {
    await startPhaseA({stateDir, target: "prod", url: URL_A});
  });

  it("returns the value and records nothing on success", async () => {
    assert.equal(
      await recordFailureOf(stateDir, "buildIdentity", async () => 7),
      7,
    );
    assert.deepEqual((await readState(stateDir)).results, {});
  });

  it("records a fail result with the message and rethrows", async () => {
    await assert.rejects(
      recordFailureOf(stateDir, "buildIdentity", async () => {
        throw new Error("no meta here\n\nsecond line");
      }),
      /no meta here/,
    );

    const {results} = await readState(stateDir);

    assert.equal(results.buildIdentity.status, "fail");
    assert.match(results.buildIdentity.detail, /no meta here/);
  });

  it("keeps a more specific failure that was already recorded", async () => {
    await assert.rejects(
      recordFailureOf(stateDir, "buildIdentity", async () => {
        await recordResult(stateDir, "buildIdentity", {
          status: "fail",
          detail: "listed violations",
        });
        throw new Error("expect(received).toEqual(expected)");
      }),
    );

    assert.equal(
      (await readState(stateDir)).results.buildIdentity.detail,
      "listed violations",
    );
  });
});

describe("GATE-001 phase B profile snapshot", () => {
  const writeProfile = async (files) => {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(stateDir, "profile", ...name.split("/").slice(0, -1)), {
        recursive: true,
      });
      await writeFile(join(stateDir, "profile", ...name.split("/")), text);
    }
  };
  const read = (...parts) => readFile(join(stateDir, ...parts), "utf8");

  beforeEach(async () => {
    await startPhaseA({stateDir, target: "prod", url: URL_A});
  });

  it("snapshots the profile on the first phase B run", async () => {
    await writeProfile({marker: "m1", "Default/db": "one"});

    assert.deepEqual(await prepareProfileForPhaseB(stateDir), {
      restored: false,
    });
    assert.equal(await read("profile-before-b", "marker"), "m1");
    assert.equal(await read("profile-before-b", "Default", "db"), "one");
    assert.equal(
      statePaths(stateDir).snapshotDir,
      join(stateDir, "profile-before-b"),
    );
  });

  it("restores the profile from the snapshot on a rerun", async () => {
    await writeProfile({marker: "m1", "Default/db": "one"});
    await prepareProfileForPhaseB(stateDir);

    // What a failed phase B run leaves behind: a changed and a new file, a removed one.
    await writeProfile({"Default/db": "changed", "Default/extra": "new"});
    await rm(join(stateDir, "profile", "marker"));

    assert.deepEqual(await prepareProfileForPhaseB(stateDir), {restored: true});
    assert.equal(await read("profile", "marker"), "m1");
    assert.equal(await read("profile", "Default", "db"), "one");
    assert.equal(
      existsSync(join(stateDir, "profile", "Default", "extra")),
      false,
    );

    // The snapshot is kept for further reruns.
    await writeProfile({"Default/db": "again"});
    assert.deepEqual(await prepareProfileForPhaseB(stateDir), {restored: true});
    assert.equal(await read("profile", "Default", "db"), "one");
  });

  it("fails clearly when there is no profile to snapshot", async () => {
    await rm(join(stateDir, "profile"), {recursive: true});

    await assert.rejects(prepareProfileForPhaseB(stateDir), /no profile/i);
  });

  it("phase A deletes the snapshot with the rest of the dir", async () => {
    await writeProfile({marker: "m1"});
    await prepareProfileForPhaseB(stateDir);
    await startPhaseA({stateDir, target: "prod", url: URL_A});

    assert.equal(existsSync(statePaths(stateDir).snapshotDir), false);
  });
});

describe("GATE-001 phase B precondition", () => {
  const passed = () => ({
    a: {
      reloadDetail: "Phase A pass.",
      profileMarker: "token",
      networkSummary: "0 non-GET request(s)",
      finishedAt: "2026-10-10T10:05:00.000Z",
      exitCode: 0,
    },
    results: {reload: {status: "pending", detail: "x", phase: "A"}},
  });

  it("is satisfied by a passed phase A", () => {
    assert.equal(phaseAIncompleteReason(passed()), null);
    assert.doesNotThrow(() => assertPhaseAPassed(passed()));
  });

  it("names every missing piece", () => {
    const state = passed();

    delete state.a.reloadDetail;
    delete state.a.profileMarker;
    delete state.a.networkSummary;

    const reason = phaseAIncompleteReason(state);

    assert.match(reason, /reloadDetail/);
    assert.match(reason, /profileMarker/);
    assert.match(reason, /networkSummary/);
  });

  it("names a failed phase A result", () => {
    const state = passed();

    state.results.cliParity = {status: "fail", detail: "boom", phase: "A"};

    assert.match(phaseAIncompleteReason(state), /cliParity/);
  });

  it("refuses a phase A whose Playwright run exited non-zero, naming the exit code", () => {
    const state = passed();

    state.a.exitCode = 1;

    assert.match(phaseAIncompleteReason(state), /Playwright exit code 1/);
    assert.throws(
      () => assertPhaseAPassed(state),
      /^Error: Phase A did not pass \(Playwright exit code 1\); rerun phase A before phase B$/,
    );
  });

  it("refuses a phase A that never finished, naming finishedAt", () => {
    const state = passed();

    delete state.a.finishedAt;

    assert.match(phaseAIncompleteReason(state), /finishedAt/);
    assert.throws(() => assertPhaseAPassed(state), /finishedAt.*rerun phase A/);
  });

  it("refuses a phase A with no recorded exit code", () => {
    const state = passed();

    delete state.a.exitCode;

    assert.match(phaseAIncompleteReason(state), /exit code/i);
  });

  it("ignores failures stamped for phase B", () => {
    const state = passed();

    state.results.deleteReimport = {status: "fail", detail: "x", phase: "B"};

    assert.equal(phaseAIncompleteReason(state), null);
  });

  it("throws the fail-fast message", () => {
    const state = passed();

    delete state.a.profileMarker;

    assert.throws(
      () => assertPhaseAPassed(state),
      /^Error: Phase A did not pass \(.*profileMarker.*\); rerun phase A before phase B$/,
    );
  });
});

describe("GATE-001 recordFailureOf label", () => {
  it("prefixes the recorded detail with the label", async () => {
    await startPhaseA({stateDir, target: "prod", url: URL_A});
    await assert.rejects(
      recordFailureOf(
        stateDir,
        "reload",
        async () => {
          throw new Error("boom");
        },
        {label: "step 5"},
      ),
    );

    assert.equal(
      (await readState(stateDir)).results.reload.detail,
      "step 5: boom",
    );
  });
});

describe("GATE-001 profile snapshot is atomic", () => {
  const failingCopy = async () => {
    throw new Error("ENOSPC: no space left on device");
  };
  const halfCopy = async (from, to) => {
    await mkdir(to, {recursive: true});
    await writeFile(join(to, "partial"), "half");
    throw new Error("ENOSPC: no space left on device");
  };

  beforeEach(async () => {
    await startPhaseA({stateDir, target: "prod", url: URL_A});
    await writeFile(join(stateDir, "profile", "marker"), "live");
  });

  it("replaces a stale .tmp left by an interrupted run", async () => {
    const tmp = join(stateDir, "profile-before-b.tmp");

    await mkdir(tmp, {recursive: true});
    await writeFile(join(tmp, "junk"), "stale");

    assert.deepEqual(await prepareProfileForPhaseB(stateDir), {
      restored: false,
    });
    assert.equal(existsSync(tmp), false);
    assert.equal(existsSync(join(stateDir, "profile-before-b", "junk")), false);
    assert.equal(
      await readFile(join(stateDir, "profile-before-b", "marker"), "utf8"),
      "live",
    );
  });

  it("a failed snapshot copy leaves no snapshot and the live profile untouched", async () => {
    await assert.rejects(
      prepareProfileForPhaseB(stateDir, {copy: halfCopy}),
      /ENOSPC/,
    );

    assert.equal(existsSync(join(stateDir, "profile-before-b")), false);
    assert.equal(existsSync(join(stateDir, "profile-before-b.tmp")), false);
    assert.equal(
      await readFile(join(stateDir, "profile", "marker"), "utf8"),
      "live",
    );

    // The next run snapshots normally instead of restoring from a half copy.
    assert.deepEqual(await prepareProfileForPhaseB(stateDir), {
      restored: false,
    });
  });

  it("a failed restore copy leaves the profile and the snapshot intact", async () => {
    await prepareProfileForPhaseB(stateDir);
    await writeFile(join(stateDir, "profile", "marker"), "changed by phase B");

    await assert.rejects(
      prepareProfileForPhaseB(stateDir, {copy: failingCopy}),
      /ENOSPC/,
    );

    assert.equal(
      await readFile(join(stateDir, "profile", "marker"), "utf8"),
      "changed by phase B",
    );
    assert.equal(
      await readFile(join(stateDir, "profile-before-b", "marker"), "utf8"),
      "live",
    );
    assert.deepEqual(await prepareProfileForPhaseB(stateDir), {restored: true});
    assert.equal(
      await readFile(join(stateDir, "profile", "marker"), "utf8"),
      "live",
    );
  });

  it("restores via a temp copy and leaves no .tmp behind", async () => {
    await prepareProfileForPhaseB(stateDir);
    await prepareProfileForPhaseB(stateDir);

    assert.equal(existsSync(join(stateDir, "profile.tmp")), false);
    assert.equal(existsSync(join(stateDir, "profile-before-b.tmp")), false);
  });
});

describe("GATE-001 recordFailureOf guards its own bookkeeping", () => {
  it("rethrows the original error when state cannot be read or written", async () => {
    const original = new Error("the step failed");

    await assert.rejects(
      recordFailureOf(join(root, "no-such-dir"), "reload", async () => {
        throw original;
      }),
      (error) => error === original,
    );
  });
});

describe("GATE-001 target directory containment", () => {
  it("accepts only a direct child of <root>/.gate", () => {
    assert.doesNotThrow(() => assertInsideGateDir(join(root, ".gate", "prod"), root));
    assert.doesNotThrow(() => assertInsideGateDir(join(root, ".gate", "prod")));
  });

  it("rejects the root, .gate itself, a sibling, a parent and nested paths", () => {
    for (const bad of [
      root,
      join(root, ".gate"),
      join(root, ".gate", ".."),
      join(root, ".gate", "..", ".."),
      join(root, ".gate", "."),
      join(root, "other", "prod"),
      join(root, ".gate", "a", "b"),
      join(root, ".gate-x", "prod"),
      join(root, "src"),
    ]) {
      assert.throws(() => assertInsideGateDir(bad, root), /\.gate/, bad);
      assert.throws(() => assertInsideGateDir(bad), /\.gate/, bad);
    }
  });

  it("rejects a .gate dir that belongs to another root when a root is given", () => {
    assert.throws(
      () => assertInsideGateDir(join(root, "elsewhere", ".gate", "prod"), root),
      /\.gate/,
    );
  });

  it("targetDir rejects unsafe slugs", () => {
    for (const slug of ["", ".", "..", "../x", "a/b", "A", "x y"]) {
      assert.throws(() => targetDir(slug, root), /slug/i, JSON.stringify(slug));
    }
    assert.equal(targetDir("host-prod", root), join(root, ".gate", "host-prod"));
  });

  it("phase A deletes nothing outside .gate/<slug>", async () => {
    await writeFile(join(root, "keep.txt"), "keep");
    await mkdir(join(root, ".gate"), {recursive: true});
    await writeFile(join(root, ".gate", "sibling.txt"), "keep");

    for (const bad of [
      root,
      join(root, ".gate"),
      join(root, ".gate", ".."),
      join(root, "other"),
    ]) {
      await assert.rejects(
        startPhaseA({stateDir: bad, target: "x", url: URL_A, root}),
        /\.gate/,
        bad,
      );
    }

    assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "keep");
    assert.equal(await readFile(join(root, ".gate", "sibling.txt"), "utf8"), "keep");
  });

  it("the profile snapshot step deletes nothing outside .gate/<slug>", async () => {
    await mkdir(join(root, "profile"), {recursive: true});
    await writeFile(join(root, "profile", "keep.txt"), "keep");
    await mkdir(join(root, "profile-before-b"), {recursive: true});

    await assert.rejects(prepareProfileForPhaseB(root), /\.gate/);
    assert.equal(await readFile(join(root, "profile", "keep.txt"), "utf8"), "keep");
    assert.equal(existsSync(join(root, "profile-before-b")), true);
  });
});

describe("GATE-001 phase A refuses to wipe an open A to B window", () => {
  const seed = async (patchA = finishedA()) => {
    await startPhaseA({stateDir, target: "prod", url: URL_A});
    await mergePhase(stateDir, "A", patchA);
    await writeFile(join(stateDir, "profile", "marker.txt"), "keep");
  };
  const markerSurvives = async () =>
    (await readFile(join(stateDir, "profile", "marker.txt"), "utf8")) === "keep";

  it("refuses when phase A passed and phase B has not run, leaving everything", async () => {
    await seed();

    await assert.rejects(
      startPhaseA({stateDir, target: "prod", url: URL_A}),
      /phase A already passed.*--fresh/is,
    );
    assert.equal(await markerSurvives(), true);
    assert.equal((await readState(stateDir)).a.identity.deployId, "d1");
  });

  it("refuses while phase B has started but not finished", async () => {
    await seed();
    await startPhaseB({stateDir, url: URL_A});

    await assert.rejects(
      startPhaseA({stateDir, target: "prod", url: URL_A}),
      /phase B has not completed.*--fresh/is,
    );
    assert.equal(await markerSurvives(), true);
  });

  it("refuses after a failed phase B (Playwright exit code or a failed result)", async () => {
    await seed();
    await startPhaseB({stateDir, url: URL_A});
    await mergePhase(stateDir, "B", {finishedAt: "t", exitCode: 1});

    await assert.rejects(
      startPhaseA({stateDir, target: "prod", url: URL_A}),
      /--fresh/,
    );

    await mergePhase(stateDir, "B", {exitCode: 0});
    await recordResult(stateDir, "deleteReimport", {
      status: "fail",
      detail: "boom",
      phase: "B",
    });

    await assert.rejects(
      startPhaseA({stateDir, target: "prod", url: URL_A}),
      /--fresh/,
    );
    assert.equal(await markerSurvives(), true);
  });

  it("proceeds without --fresh after a completed, passing phase B", async () => {
    await seed();
    await startPhaseB({stateDir, url: URL_A});
    await mergePhase(stateDir, "B", {finishedAt: "t", exitCode: 0});

    const state = await startPhaseA({stateDir, target: "prod", url: URL_A});

    assert.equal(state.b, undefined);
    assert.equal(existsSync(join(stateDir, "profile", "marker.txt")), false);
  });

  it("starts over with fresh: true", async () => {
    await seed();

    const state = await startPhaseA({
      stateDir,
      target: "prod",
      url: URL_A,
      fresh: true,
    });

    assert.deepEqual(state.results, {});
    assert.equal(existsSync(join(stateDir, "profile", "marker.txt")), false);
  });

  it("does not refuse when there is no state", async () => {
    await assert.doesNotReject(
      startPhaseA({stateDir, target: "prod", url: URL_A}),
    );
  });

  it("does not refuse when state.json is unreadable", async () => {
    await seed();
    await writeFile(join(stateDir, "state.json"), "{not json");

    await assert.doesNotReject(
      startPhaseA({stateDir, target: "prod", url: URL_A}),
    );
  });

  it("does not refuse when the earlier phase A did not pass", async () => {
    await seed({identity: identity("d1")});
    await recordResult(stateDir, "reload", {
      status: "fail",
      detail: "boom",
      phase: "A",
    });

    await assert.doesNotReject(
      startPhaseA({stateDir, target: "prod", url: URL_A}),
    );
  });

  it("does not refuse when Playwright exited non-zero in the earlier phase A", async () => {
    await seed({...finishedA(), exitCode: 1});

    await assert.doesNotReject(
      startPhaseA({stateDir, target: "prod", url: URL_A}),
    );
  });
});
