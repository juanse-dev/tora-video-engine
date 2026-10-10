import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, it} from "node:test";
import {
  assertNewBuild,
  mergePhase,
  readGateEnv,
  readState,
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

  it("starts B, keeps A and drops results and Netlify data of an earlier B run", async () => {
    await startPhaseA({stateDir, target: "prod", url: URL_A});
    await mergePhase(stateDir, "A", {identity: identity("d1")});
    await recordResult(stateDir, "reload", {status: "pass", detail: "ok", phase: "A"});
    await recordResult(stateDir, "deleteReimport", {status: "pass", detail: "old", phase: "B"});
    await recordNetlify(stateDir, "A", {status: "pass", detail: "a"});
    await startPhaseB({stateDir, url: URL_A, now: "t1"});
    await recordResult(stateDir, "deleteReimport", {status: "fail", detail: "stale", phase: "B"});
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
    await mergePhase(stateDir, "A", {browser: {name: "Chrome", version: "154"}});
    await mergePhase(stateDir, "A", {identity: identity("d1")});

    const state = await readState(stateDir);

    assert.equal(state.a.browser.version, "154");
    assert.equal(state.a.identity.deployId, "d1");
    assert.ok(state.a.startedAt);
  });

  it("records results keyed by name and overwrites the same key", async () => {
    await recordResult(stateDir, "reload", {status: "pending", detail: "A ok", phase: "A"});
    await recordResult(stateDir, "reload", {status: "pass", detail: "all ok", phase: "B"});
    await recordResult(stateDir, "cliParity", {status: "fail", detail: "boom"});

    const {results} = await readState(stateDir);

    assert.deepEqual(results.reload, {status: "pass", detail: "all ok", phase: "B"});
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
    await recordNetlify(stateDir, "A", {status: "manual", detail: "manual (no token)"});

    assert.equal((await readState(stateDir)).netlify.A.status, "manual");
  });

  it("serialises to valid JSON on disk", async () => {
    await recordResult(stateDir, "reload", {status: "pass", detail: "ok", phase: "A"});

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
    assert.throws(() => assertNewBuild({a: {}}, identity("d2")), /no build identity/);
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
    assert.throws(() => readGateEnv({...full, TORA_GATE_PHASE: "C"}), /TORA_GATE_PHASE/);
  });
});
