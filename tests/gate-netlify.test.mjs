import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  checkNetlifyDeploy,
  netlifyApplicability,
  resolveNetlifyResult,
  NETLIFY_API,
  NETLIFY_SITE,
} from "../scripts/gateNetlify.mjs";

const TOKEN = "nfp_SECRET_TOKEN";
const identity = {
  commit: "d4aa69a0123456789abcdef0123456789abcdef0",
  deployId: "6ac9d19a7ca32e0009507632",
  context: "production",
};

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// A fake Netlify API. Records every call so tests can assert read-only use.
const fakeNetlify = ({site, deploy, siteStatus = 200, deployStatus = 200}) => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({url, method: init.method ?? "GET", headers: init.headers});

    if (url === `${NETLIFY_API}/sites/${NETLIFY_SITE}`) {
      return json(siteStatus, site);
    }

    if (url === `${NETLIFY_API}/deploys/${identity.deployId}`) {
      return json(deployStatus, deploy);
    }

    return json(404, {});
  };

  return {fetch, calls};
};

const readyDeploy = (overrides = {}) => ({
  id: identity.deployId,
  state: "ready",
  commit_ref: identity.commit,
  available_functions: [],
  ...overrides,
});

const publishedSite = (id = identity.deployId) => ({
  id: "site-1",
  published_deploy: {id},
});

describe("GATE-001 G8 Netlify check", () => {
  it("names the site by domain and calls only GET endpoints", async () => {
    const {fetch, calls} = fakeNetlify({
      site: publishedSite(),
      deploy: readyDeploy(),
    });

    await checkNetlifyDeploy({token: TOKEN, identity, isProduction: true, fetch});

    assert.equal(NETLIFY_SITE, "tora-video-engine.netlify.app");
    assert.deepEqual(
      calls.map(({url, method}) => [method, url]),
      [
        ["GET", "https://api.netlify.com/api/v1/sites/tora-video-engine.netlify.app"],
        ["GET", `https://api.netlify.com/api/v1/deploys/${identity.deployId}`],
      ],
    );
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  });

  it("passes when the deploy is ready, matches the commit and is published", async () => {
    const {fetch} = fakeNetlify({site: publishedSite(), deploy: readyDeploy()});
    const result = await checkNetlifyDeploy({
      token: TOKEN,
      identity,
      isProduction: true,
      fetch,
    });

    assert.equal(result.status, "pass");
    assert.match(result.detail, /ready/);
    assert.match(result.detail, /published/);
    assert.match(result.detail, /Functions: none/);
    assert.deepEqual(
      result.checks.map(({name, ok}) => [name, ok]),
      [
        ["deploy state is ready", true],
        ["commit matches the page", true],
        ["deploy is the published production deploy", true],
      ],
    );
  });

  it("accepts a short page commit against the full commit_ref", async () => {
    const {fetch} = fakeNetlify({site: publishedSite(), deploy: readyDeploy()});
    const result = await checkNetlifyDeploy({
      token: TOKEN,
      identity: {...identity, commit: "d4aa69a"},
      isProduction: true,
      fetch,
    });

    assert.equal(result.status, "pass");
  });

  it("fails production when the deploy is not the published one", async () => {
    const {fetch} = fakeNetlify({
      site: publishedSite("someotherdeploy"),
      deploy: readyDeploy(),
    });
    const result = await checkNetlifyDeploy({
      token: TOKEN,
      identity,
      isProduction: true,
      fetch,
    });

    assert.equal(result.status, "fail");
    assert.match(result.detail, /not the published deploy/);
    assert.match(result.detail, /someotherdeploy/);
  });

  it("does not require a preview deploy to be published", async () => {
    const {fetch} = fakeNetlify({
      site: publishedSite("someotherdeploy"),
      deploy: readyDeploy(),
    });
    const result = await checkNetlifyDeploy({
      token: TOKEN,
      identity,
      isProduction: false,
      fetch,
    });

    assert.equal(result.status, "pass");
    assert.equal(result.checks.length, 2);
  });

  it("fails on a commit mismatch", async () => {
    const {fetch} = fakeNetlify({
      site: publishedSite(),
      deploy: readyDeploy({commit_ref: "ffffffffffffffffffffffffffffffffffffffff"}),
    });
    const result = await checkNetlifyDeploy({
      token: TOKEN,
      identity,
      isProduction: true,
      fetch,
    });

    assert.equal(result.status, "fail");
    assert.match(result.detail, /commit mismatch/);
    assert.match(result.detail, /ffffffffffff/);
    assert.match(result.detail, /d4aa69a/);
  });

  it("fails when the deploy is not ready", async () => {
    const {fetch} = fakeNetlify({
      site: publishedSite(),
      deploy: readyDeploy({state: "building"}),
    });
    const result = await checkNetlifyDeploy({
      token: TOKEN,
      identity,
      isProduction: true,
      fetch,
    });

    assert.equal(result.status, "fail");
    assert.match(result.detail, /"building"/);
  });

  it("records whether the deploy has Functions", async () => {
    const {fetch} = fakeNetlify({
      site: publishedSite(),
      deploy: readyDeploy({available_functions: [{n: "a"}, {n: "b"}]}),
    });
    const result = await checkNetlifyDeploy({
      token: TOKEN,
      identity,
      isProduction: true,
      fetch,
    });

    assert.equal(result.status, "pass");
    assert.match(result.detail, /Functions: 2/);
  });

  it("reads Functions from the functions field too", async () => {
    const {fetch} = fakeNetlify({
      site: publishedSite(),
      deploy: readyDeploy({available_functions: undefined, functions: ["x"]}),
    });
    const result = await checkNetlifyDeploy({
      token: TOKEN,
      identity,
      isProduction: true,
      fetch,
    });

    assert.match(result.detail, /Functions: 1/);
  });

  it("says Edge Functions are not checked, whatever the Functions count", async () => {
    for (const deploy of [
      readyDeploy(),
      readyDeploy({available_functions: [{n: "a"}]}),
    ]) {
      const {fetch} = fakeNetlify({site: publishedSite(), deploy});
      const result = await checkNetlifyDeploy({
        token: TOKEN,
        identity,
        isProduction: true,
        fetch,
      });

      assert.equal(result.status, "pass");
      assert.match(
        result.detail,
        /Edge Functions: not checked \(confirm in the Netlify UI\)/,
      );
    }
  });

  it("reports manual when there is no token and makes no request", async () => {
    const {fetch, calls} = fakeNetlify({site: publishedSite(), deploy: readyDeploy()});

    for (const token of [undefined, "", "  "]) {
      const result = await checkNetlifyDeploy({
        token,
        identity,
        isProduction: true,
        fetch,
      });

      assert.deepEqual(result, {status: "manual", detail: "manual (no token)"});
    }

    assert.equal(calls.length, 0);
  });

  it("fails with a clear message on an API error, without the token", async () => {
    const {fetch} = fakeNetlify({
      site: {},
      deploy: {},
      siteStatus: 401,
    });
    const result = await checkNetlifyDeploy({
      token: TOKEN,
      identity,
      isProduction: true,
      fetch,
    });

    assert.equal(result.status, "fail");
    assert.match(result.detail, /401/);
    assert.match(result.detail, /NETLIFY_AUTH_TOKEN/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
  });

  it("fails when the deploy is unknown to Netlify", async () => {
    const {fetch} = fakeNetlify({
      site: publishedSite(),
      deploy: {},
      deployStatus: 404,
    });
    const result = await checkNetlifyDeploy({
      token: TOKEN,
      identity,
      isProduction: true,
      fetch,
    });

    assert.equal(result.status, "fail");
    assert.match(result.detail, /404/);
  });

  it("fails (not throws) when fetch rejects", async () => {
    const result = await checkNetlifyDeploy({
      token: TOKEN,
      identity,
      isProduction: true,
      fetch: async () => {
        throw new Error("network down");
      },
    });

    assert.equal(result.status, "fail");
    assert.match(result.detail, /network down/);
  });

  it("skips when the page recorded no build identity", async () => {
    const {fetch, calls} = fakeNetlify({site: publishedSite(), deploy: readyDeploy()});
    const result = await checkNetlifyDeploy({
      token: TOKEN,
      identity: undefined,
      isProduction: true,
      fetch,
    });

    assert.equal(result.status, "skip");
    assert.equal(calls.length, 0);
  });

  it("fails a local-<epoch> deploy id without calling the API", async () => {
    const {fetch, calls} = fakeNetlify({site: publishedSite(), deploy: readyDeploy()});
    const result = await checkNetlifyDeploy({
      token: TOKEN,
      identity: {...identity, deployId: "local-1700000000000"},
      isProduction: true,
      fetch,
    });

    assert.equal(result.status, "fail");
    assert.match(result.detail, /not a Netlify deploy/);
    assert.equal(calls.length, 0);
  });
});

describe("GATE-001 G8 when the Netlify check applies", () => {
  it("applies to this project's site and its Deploy Preview or branch aliases", () => {
    for (const url of [
      "https://tora-video-engine.netlify.app",
      "https://deploy-preview-3--tora-video-engine.netlify.app",
      "https://deploy-preview-28--tora-video-engine.netlify.app/",
      "https://feat-x--tora-video-engine.netlify.app",
      "https://TORA-VIDEO-ENGINE.netlify.app",
    ]) {
      assert.equal(netlifyApplicability({url, local: false}), null);
    }
  });

  it("skips a local target", () => {
    assert.deepEqual(netlifyApplicability({url: "http://127.0.0.1:4190", local: true}), {
      status: "skip",
      detail: "not applicable to a local target",
    });
  });

  it("skips another Netlify site instead of querying this project's", () => {
    for (const url of [
      "https://another-site.netlify.app",
      "https://deploy-preview-3--another-site.netlify.app",
      "https://evil--tora-video-engine.netlify.app.example.com",
      "https://xtora-video-engine.netlify.app",
      "https://not-tora-video-engine.netlify.app",
    ]) {
      assert.deepEqual(netlifyApplicability({url, local: false}), {
        status: "skip",
        detail: "not this project's Netlify site",
      });
    }
  });

  it("skips hosts outside netlify.app instead of failing them", () => {
    for (const url of [
      "https://example.com",
      "http://127.0.0.1:5000",
      "https://evilnetlify.app",
      "https://netlify.app.example.com",
    ]) {
      assert.deepEqual(netlifyApplicability({url, local: false}), {
        status: "skip",
        detail: "not this project's Netlify site",
      });
    }
  });
});

describe("GATE-001 resolveNetlifyResult always yields a result to record", () => {
  const prod = {name: "prod", url: `https://${NETLIFY_SITE}`, local: false};
  const never = async () => {
    throw new Error("the check must not run");
  };

  it("records skip for a local target without running the check", async () => {
    const result = await resolveNetlifyResult({
      target: {name: "local", url: "http://127.0.0.1:4190", local: true},
      token: TOKEN,
      getIdentity: async () => identity,
      check: never,
    });

    assert.equal(result.status, "skip");
  });

  it("records skip for a host that is not this project's site", async () => {
    const result = await resolveNetlifyResult({
      target: {name: "host-x", url: "https://other.example.com", local: false},
      token: TOKEN,
      getIdentity: async () => identity,
      check: never,
    });

    assert.equal(result.status, "skip");
  });

  it("records manual without a token", async () => {
    const result = await resolveNetlifyResult({
      target: prod,
      token: undefined,
      getIdentity: async () => identity,
    });

    assert.equal(result.status, "manual");
  });

  it("passes the identity and production flag to the check", async () => {
    let seen;
    const result = await resolveNetlifyResult({
      target: prod,
      token: TOKEN,
      getIdentity: async () => identity,
      check: async (options) => {
        seen = options;

        return {status: "pass", detail: "ok"};
      },
    });

    assert.equal(result.status, "pass");
    assert.deepEqual(seen, {token: TOKEN, identity, isProduction: true});
  });

  it("records fail with the message when the check throws", async () => {
    const result = await resolveNetlifyResult({
      target: prod,
      token: TOKEN,
      getIdentity: async () => identity,
      check: async () => {
        throw new Error("socket hang up");
      },
    });

    assert.equal(result.status, "fail");
    assert.match(result.detail, /socket hang up/);
    assert.doesNotMatch(result.detail, new RegExp(TOKEN));
  });

  it("records fail when the identity cannot be read", async () => {
    const result = await resolveNetlifyResult({
      target: prod,
      token: TOKEN,
      getIdentity: async () => {
        throw new Error("state.json unreadable");
      },
      check: never,
    });

    assert.equal(result.status, "fail");
    assert.match(result.detail, /state\.json unreadable/);
  });
});

describe("GATE-001 resolveNetlifyResult never records the token", () => {
  const prod = {name: "prod", url: `https://${NETLIFY_SITE}`, local: false};

  for (const [name, token] of [
    ["the token", TOKEN],
    ["a token padded with whitespace", `  ${TOKEN}
`],
  ]) {
    it(`redacts ${name} from an API error message`, async () => {
      const result = await resolveNetlifyResult({
        target: prod,
        token,
        getIdentity: async () => identity,
        fetch: async () => {
          throw new Error(`connect ECONNRESET while sending Bearer ${TOKEN} (raw ${token})`);
        },
      });

      assert.equal(result.status, "fail");
      assert.match(result.detail, /Netlify API request failed/);
      assert.doesNotMatch(JSON.stringify(result), /nfp_SECRET_TOKEN/);
    });

    it(`redacts ${name} from a failure thrown by the check itself`, async () => {
      const result = await resolveNetlifyResult({
        target: prod,
        token,
        getIdentity: async () => identity,
        check: async () => {
          throw new Error(`boom ${TOKEN}`);
        },
      });

      assert.equal(result.status, "fail");
      assert.doesNotMatch(JSON.stringify(result), /nfp_SECRET_TOKEN/);
    });
  }

  it("never redacts an empty or blank token (the detail stays intact)", async () => {
    const result = await resolveNetlifyResult({
      target: prod,
      token: "   ",
      getIdentity: async () => identity,
    });

    assert.deepEqual(result, {status: "manual", detail: "manual (no token)"});
  });
});
