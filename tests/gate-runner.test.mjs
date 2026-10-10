import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtemp, rm, symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";
import {
  assertSafeSlug,
  buildGateEnv,
  LOCAL_ORIGIN,
  parseGateArgs,
  PROD_ORIGIN,
  resolveTarget,
} from "../scripts/gateTarget.mjs";

const originHash = (origin) =>
  createHash("sha256").update(origin.toLowerCase()).digest("hex").slice(0, 10);

describe("GATE-001 G2 argument parsing", () => {
  it("parses --url, --phase, --headed and --only", () => {
    assert.deepEqual(
      parseGateArgs(["--url=prod", "--phase=A", "--headed", "--only=reload"]),
      {url: "prod", phase: "A", headed: true, only: "reload", fresh: false},
    );
  });

  it("accepts a space-separated value and a lower-case phase", () => {
    assert.deepEqual(parseGateArgs(["--url", "local", "--phase", "b"]), {
      url: "local",
      phase: "B",
      headed: false,
      only: undefined,
      fresh: false,
    });
  });

  it("parses --fresh as a flag without a value", () => {
    assert.equal(parseGateArgs(["--url=prod", "--phase=A", "--fresh"]).fresh, true);
    assert.equal(parseGateArgs(["--url=prod", "--phase=A"]).fresh, false);
    assert.throws(
      () => parseGateArgs(["--url=prod", "--phase=A", "--fresh=1"]),
      /--fresh takes no value/,
    );
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

describe("GATE-001 npm.ps1 fallback (Windows PowerShell 5.1 drops the --)", () => {
  // npm.ps1 swallows `-- --url=x --phase=A`; npm then exports the flags as
  // npm_config_<name> environment variables and the script gets no argv.
  it("reads url, phase, only, headed and fresh from npm_config_* when argv has no --url", () => {
    assert.deepEqual(
      parseGateArgs([], {
        npm_config_url: "local",
        npm_config_phase: "a",
        npm_config_only: "reload",
        npm_config_headed: "true",
        npm_config_fresh: "true",
      }),
      {url: "local", phase: "A", headed: true, only: "reload", fresh: true},
    );
  });

  it("leaves optional flags off when npm did not export them", () => {
    assert.deepEqual(
      parseGateArgs([], {npm_config_url: "prod", npm_config_phase: "B"}),
      {url: "prod", phase: "B", headed: false, only: undefined, fresh: false},
    );
  });

  it("ignores npm_config_* when argv carries --url", () => {
    assert.deepEqual(
      parseGateArgs(["--url=prod", "--phase=A"], {
        npm_config_url: "local",
        npm_config_phase: "B",
        npm_config_headed: "true",
      }),
      {url: "prod", phase: "A", headed: false, only: undefined, fresh: false},
    );
  });

  it("does not treat npm_config_headed=false as a request", () => {
    assert.equal(
      parseGateArgs([], {
        npm_config_url: "local",
        npm_config_phase: "A",
        npm_config_headed: "false",
      }).headed,
      false,
    );
  });

  it("points at npm.cmd and node when nothing resolves a --url", () => {
    assert.throws(
      () => parseGateArgs([], {}),
      (error) =>
        /--url is required/.test(error.message) &&
        /npm\.cmd run gate -- /.test(error.message) &&
        /node scripts\/gate\.mjs /.test(error.message),
    );
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
      slug: `host-staging.example.com-8443-${originHash("https://staging.example.com:8443")}`,
      url: "https://staging.example.com:8443",
      local: false,
    });
  });

  it("prefixes custom-host slugs so they never collide with the built-in slugs", () => {
    assert.match(resolveTarget("https://prod").slug, /^host-prod-[0-9a-f]{10}$/);
    assert.match(resolveTarget("https://local").slug, /^host-local-[0-9a-f]{10}$/);
    assert.match(resolveTarget("https://preview-3").slug, /^host-preview-3-[0-9a-f]{10}$/);
    assert.notEqual(resolveTarget("https://prod").slug, resolveTarget("prod").slug);
  });

  it("gives origins that sanitize to the same host text different slugs", () => {
    const port = resolveTarget("https://example.com:8443");
    const dash = resolveTarget("https://example.com-8443");

    assert.notEqual(port.slug, dash.slug);
    assert.match(port.slug, /^host-example\.com-8443-[0-9a-f]{10}$/);
    assert.match(dash.slug, /^host-example\.com-8443-[0-9a-f]{10}$/);
    assert.doesNotThrow(() => assertSafeSlug(port.slug));
    assert.doesNotThrow(() => assertSafeSlug(dash.slug));
  });

  it("gives the same origin the same slug whatever the case or trailing slash", () => {
    const slugs = new Set(
      [
        "https://example.com:8443",
        "https://example.com:8443/",
        "https://EXAMPLE.com:8443",
        "HTTPS://Example.COM:8443/",
      ].map((url) => resolveTarget(url).slug),
    );

    assert.equal(slugs.size, 1);
  });

  it("keeps the built-in slugs unchanged", () => {
    assert.equal(resolveTarget("prod").slug, "prod");
    assert.equal(resolveTarget("local").slug, "local");
    assert.equal(resolveTarget("preview:28").slug, "preview-28");
    assert.equal(resolveTarget("https://tora-video-engine.netlify.app").slug, "prod");
  });

  it("rejects hosts whose slug would be empty, . or .. (they escape .gate/)", () => {
    for (const bad of ["https://..", "https://.", "https://...", "https://-"]) {
      assert.throws(() => resolveTarget(bad), /host/i, bad);
    }
  });

  it("only produces slugs made of [a-z0-9.-]", () => {
    for (const value of [
      "https://exa_mple.com",
      "https://[::1]:8443",
      "https://a..b",
      "https://xn--bcher-kva.example:9000",
    ]) {
      const {slug} = resolveTarget(value);

      assert.match(slug, /^[a-z0-9.-]+$/, value);
      assert.doesNotThrow(() => assertSafeSlug(slug), value);
    }
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

describe("GATE-001 slug safety", () => {
  it("accepts the built-in and custom slugs", () => {
    for (const slug of ["prod", "local", "preview-28", "host-a.b-c"]) {
      assert.doesNotThrow(() => assertSafeSlug(slug), slug);
    }
  });

  it("rejects empty, ., .. and anything outside [a-z0-9.-]", () => {
    for (const bad of [
      "",
      ".",
      "..",
      "a/b",
      "a\b",
      "../x",
      "A",
      "a b",
      "a:b",
      undefined,
    ]) {
      assert.throws(() => assertSafeSlug(bad), /slug/i, String(bad));
    }
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

describe("GATE-001 runner entry through a junction or symlink", () => {
  it("still runs main() when started through a linked path", async () => {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const holder = await mkdtemp(join(tmpdir(), "gate-link-"));
    const link = join(holder, "repo-link");

    try {
      await symlink(repo, link, "junction");

      const result = spawnSync(
        process.execPath,
        [join(link, "scripts", "gate.mjs"), "--url=staging", "--phase=A"],
        {encoding: "utf8"},
      );

      // A silent exit 0 is the bug: main() must run and reject the target.
      assert.equal(result.status, 2);
      assert.match(result.stderr, /Unknown target "staging"/);
    } finally {
      await rm(holder, {recursive: true, force: true});
    }
  });
});
