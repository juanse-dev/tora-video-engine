import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  buildIdentityPlugin,
  formatBuildIdentity,
  resolveBuildIdentity,
} from "../vite.config.mts";
import {
  allowsPreviewDrawer,
  formatIdentity,
  parseBuildIdentity,
} from "./gate/helpers/buildIdentity.mjs";

const noGit = () => null;

describe("GATE-001 G1 build identity (vite plugin)", () => {
  it("uses the Netlify build env when present", () => {
    const identity = resolveBuildIdentity({
      env: {
        COMMIT_REF: "d4aa69a0123456789abcdef0123456789abcdef0",
        DEPLOY_ID: "6ac9d19a7ca32e0009507632",
        CONTEXT: "production",
      },
      now: 1_700_000_000_000,
      gitCommit: () => "ignored",
    });

    assert.deepEqual(identity, {
      commit: "d4aa69a0123456789abcdef0123456789abcdef0",
      deployId: "6ac9d19a7ca32e0009507632",
      context: "production",
    });
  });

  it("falls back to git, a local-<epoch> deploy id and the local context", () => {
    const identity = resolveBuildIdentity({
      env: {},
      now: 1_700_000_000_123,
      gitCommit: () => "abc1234",
    });

    assert.deepEqual(identity, {
      commit: "abc1234",
      deployId: "local-1700000000123",
      context: "local",
    });
  });

  it("uses 'unknown' when git is unavailable and treats empty env as unset", () => {
    const identity = resolveBuildIdentity({
      env: {COMMIT_REF: "", DEPLOY_ID: "  ", CONTEXT: ""},
      now: 5,
      gitCommit: noGit,
    });

    assert.deepEqual(identity, {
      commit: "unknown",
      deployId: "local-5",
      context: "local",
    });
  });

  it("keeps the separator and markup out of the meta content", () => {
    const identity = resolveBuildIdentity({
      env: {COMMIT_REF: 'a/b"c>', DEPLOY_ID: "x y", CONTEXT: "deploy-preview"},
      now: 1,
      gitCommit: noGit,
    });

    assert.equal(formatBuildIdentity(identity), "a-b-c-/x-y/deploy-preview");
  });

  it("injects <meta name=tora-build> into the head", () => {
    const plugin = buildIdentityPlugin({
      commit: "abc1234",
      deployId: "local-1",
      context: "local",
    });
    const tags = plugin.transformIndexHtml();

    assert.deepEqual(tags, [
      {
        tag: "meta",
        attrs: {name: "tora-build", content: "abc1234/local-1/local"},
        injectTo: "head",
      },
    ]);
  });

  it("resolves the identity lazily, once, on the first transform", () => {
    let calls = 0;
    const plugin = buildIdentityPlugin(() => {
      calls += 1;

      return {commit: "abc1234", deployId: "local-1", context: "local"};
    });

    assert.equal(calls, 0);
    plugin.transformIndexHtml();
    plugin.transformIndexHtml();
    assert.equal(calls, 1);
  });

  it("round-trips through the gate's parser", () => {
    const identity = {commit: "abc1234", deployId: "local-1", context: "local"};

    assert.equal(formatIdentity(identity), formatBuildIdentity(identity));
    assert.deepEqual(parseBuildIdentity("abc1234/local-1/local"), identity);
  });

  it("rejects malformed meta content with a clear message", () => {
    for (const bad of ["", "a/b", "a/b/c/d", "//", null, undefined]) {
      assert.throws(() => parseBuildIdentity(bad), /tora-build/);
    }
  });
});

describe("GATE-001 R10 allowsPreviewDrawer", () => {
  const identity = (context) => ({commit: "abc1234", deployId: "d1", context});

  it("is true for a known context other than production", () => {
    for (const context of ["deploy-preview", "branch-deploy", "local", "dev"]) {
      assert.equal(allowsPreviewDrawer(identity(context)), true, context);
    }
  });

  it("is false for production and for an unknown identity", () => {
    assert.equal(allowsPreviewDrawer(identity("production")), false);

    for (const unknown of [null, undefined, {}, identity(""), identity(undefined)]) {
      assert.equal(allowsPreviewDrawer(unknown), false);
    }
  });
});
