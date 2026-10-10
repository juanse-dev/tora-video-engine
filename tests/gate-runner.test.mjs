import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {describe, it} from "node:test";
import {
  buildGateEnv,
  LOCAL_ORIGIN,
  parseGateArgs,
  PROD_ORIGIN,
  resolveTarget,
} from "../scripts/gateTarget.mjs";

describe("GATE-001 G2 argument parsing", () => {
  it("parses --url, --phase, --headed and --only", () => {
    assert.deepEqual(
      parseGateArgs(["--url=prod", "--phase=A", "--headed", "--only=reload"]),
      {url: "prod", phase: "A", headed: true, only: "reload"},
    );
  });

  it("accepts a space-separated value and a lower-case phase", () => {
    assert.deepEqual(parseGateArgs(["--url", "local", "--phase", "b"]), {
      url: "local",
      phase: "B",
      headed: false,
      only: undefined,
    });
  });

  it("requires --url and --phase", () => {
    assert.throws(() => parseGateArgs(["--phase=A"]), /--url/);
    assert.throws(() => parseGateArgs(["--url=prod"]), /--phase/);
  });

  it("rejects a phase other than A or B", () => {
    assert.throws(() => parseGateArgs(["--url=prod", "--phase=C"]), /A or B/);
  });

  it("rejects unknown flags and missing values", () => {
    assert.throws(
      () => parseGateArgs(["--url=prod", "--phase=A", "--bogus"]),
      /Unknown argument/,
    );
    assert.throws(() => parseGateArgs(["--url", "--phase=A"]), /--url/);
  });
});

describe("GATE-001 G2 target resolution", () => {
  it("resolves prod", () => {
    assert.deepEqual(resolveTarget("prod"), {
      name: "prod",
      slug: "prod",
      url: PROD_ORIGIN,
      local: false,
    });
    assert.equal(PROD_ORIGIN, "https://tora-video-engine.netlify.app");
  });

  it("resolves preview:<n> to the deploy-preview host", () => {
    assert.deepEqual(resolveTarget("preview:28"), {
      name: "preview:28",
      slug: "preview-28",
      url: "https://deploy-preview-28--tora-video-engine.netlify.app",
      local: false,
    });
  });

  it("rejects a malformed preview number", () => {
    for (const bad of ["preview:", "preview:0", "preview:abc", "preview:1.5"]) {
      assert.throws(() => resolveTarget(bad), /preview/);
    }
  });

  it("resolves local to the fixed vite preview port", () => {
    assert.deepEqual(resolveTarget("local"), {
      name: "local",
      slug: "local",
      url: LOCAL_ORIGIN,
      local: true,
    });
    assert.equal(LOCAL_ORIGIN, "http://127.0.0.1:4190");
  });

  it("accepts any https:// origin and slugs the host", () => {
    assert.deepEqual(resolveTarget("https://Staging.Example.com:8443/"), {
      name: "https://staging.example.com:8443",
      slug: "staging.example.com-8443",
      url: "https://staging.example.com:8443",
      local: false,
    });
  });

  it("treats the production origin as the prod alias", () => {
    assert.equal(resolveTarget(`${PROD_ORIGIN}/`).slug, "prod");
  });

  it("rejects an http:// URL that is not loopback", () => {
    assert.throws(
      () => resolveTarget("http://tora-video-engine.netlify.app"),
      /https/,
    );
  });

  it("allows http:// on a loopback host (a server the user runs)", () => {
    assert.equal(resolveTarget("http://127.0.0.1:5000").url, "http://127.0.0.1:5000");
    assert.equal(resolveTarget("http://127.0.0.1:5000").local, false);
  });

  it("rejects an unknown alias and a URL with a path", () => {
    assert.throws(() => resolveTarget("staging"), /Unknown target "staging"/);
    assert.throws(() => resolveTarget("https://example.com/app"), /origin/);
    assert.throws(() => resolveTarget("https://example.com/?a=1"), /origin/);
  });
});

describe("GATE-001 G2 playwright environment", () => {
  it("passes target, phase, state dir and mode to the config", () => {
    const env = buildGateEnv({
      target: resolveTarget("preview:3"),
      phase: "B",
      headed: true,
      stateDir: "/repo/.gate/preview-3",
    });

    assert.deepEqual(env, {
      TORA_GATE_URL: "https://deploy-preview-3--tora-video-engine.netlify.app",
      TORA_GATE_TARGET: "preview-3",
      TORA_GATE_PHASE: "B",
      TORA_GATE_LOCAL: "0",
      TORA_GATE_HEADED: "1",
      TORA_GATE_STATE_DIR: "/repo/.gate/preview-3",
    });
  });
});

describe("GATE-001 G2 runner process", () => {
  it("prints usage and exits 2 on bad arguments without starting anything", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/gate.mjs", "--url=staging", "--phase=A"],
      {encoding: "utf8"},
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown target "staging"/);
    assert.match(result.stderr, /Usage: npm run gate/);
  });
});
