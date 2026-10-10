import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "node:test";
import {
  attachNetworkGuard,
  combineGuards,
  classifyRequest,
  saveNetworkLog,
  summarizeNetwork,
  TELEMETRY_MAX_BYTES,
} from "./gate/helpers/networkGuard.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const TELEMETRY = "https://www.remotion.pro/api/register-usage-point";
const APP = "https://tora-video-engine.netlify.app";

describe("GATE-001 G6 classifyRequest", () => {
  it("allows a GET of an image", () => {
    assert.equal(
      classifyRequest({method: "GET", url: `${APP}/characters/tora/formal.png`}).ok,
      true,
    );
  });

  it("allows HEAD and OPTIONS", () => {
    for (const method of ["HEAD", "OPTIONS", "get"]) {
      assert.equal(classifyRequest({method, url: APP}).ok, true);
    }
  });

  it("allows the Remotion telemetry POST up to 4096 bytes", () => {
    for (const size of [0, 200, TELEMETRY_MAX_BYTES]) {
      const verdict = classifyRequest({
        method: "POST",
        url: TELEMETRY,
        body: Buffer.alloc(size, 0x61),
      });

      assert.equal(verdict.ok, true, `size ${size}`);
      assert.equal(verdict.allowlisted, "remotion-register-usage-point");
    }
  });

  it("allows a telemetry POST with no body", () => {
    assert.equal(classifyRequest({method: "POST", url: TELEMETRY, body: null}).ok, true);
  });

  it("rejects a telemetry POST over 4096 bytes", () => {
    const verdict = classifyRequest({
      method: "POST",
      url: TELEMETRY,
      body: Buffer.alloc(TELEMETRY_MAX_BYTES + 1, 0x61),
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /4096/);
  });

  it("rejects a POST anywhere else", () => {
    const verdict = classifyRequest({
      method: "POST",
      url: `${APP}/api/upload`,
      body: Buffer.from("x"),
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /POST/);
  });

  it("rejects a non-POST method on the telemetry path", () => {
    assert.equal(classifyRequest({method: "PUT", url: TELEMETRY, body: null}).ok, false);
  });

  it("rejects a PUT whose body has a PNG signature", () => {
    const verdict = classifyRequest({
      method: "PUT",
      url: "https://example.com/up",
      body: Buffer.concat([Buffer.from("xx"), PNG, Buffer.from("rest")]),
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /PNG/);
  });

  it("rejects a GET whose body has a JPEG signature", () => {
    const verdict = classifyRequest({method: "GET", url: APP, body: JPEG});

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /JPEG/);
  });

  it("rejects a telemetry POST that carries image bytes", () => {
    assert.equal(
      classifyRequest({method: "POST", url: TELEMETRY, body: PNG}).ok,
      false,
    );
  });

  it("rejects a body containing a fixture's bytes, whatever the method or host", () => {
    const fixture = Buffer.from("fixture-bytes-0123456789");
    const verdict = classifyRequest(
      {
        method: "GET",
        url: "https://elsewhere.example/x",
        body: Buffer.concat([Buffer.from("a"), fixture]),
      },
      {fixtureBuffers: [fixture]},
    );

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /fixture/);
  });

  it("accepts string bodies", () => {
    assert.equal(classifyRequest({method: "GET", url: APP, body: "hello"}).ok, true);
  });
});

const fakeRequest = ({method = "GET", url, body = null}) => ({
  method: () => method,
  url: () => url,
  postDataBuffer: () => body,
});

describe("GATE-001 G6 attachNetworkGuard", () => {
  it("collects violations, a non-GET log and every contacted host", () => {
    const context = new EventEmitter();
    const guard = attachNetworkGuard(context, {fixtureBuffers: []});

    context.emit("request", fakeRequest({url: `${APP}/index.html`}));
    context.emit("request", fakeRequest({url: `${APP}/a.png?token=secret`}));
    context.emit(
      "request",
      fakeRequest({method: "POST", url: TELEMETRY, body: Buffer.alloc(200)}),
    );
    context.emit(
      "request",
      fakeRequest({method: "PUT", url: "https://evil.example/up?x=1#h", body: PNG}),
    );
    context.emit("request", fakeRequest({url: "blob:https://tora-video-engine.netlify.app/abc"}));
    context.emit("request", fakeRequest({url: "data:image/png;base64,AAAA"}));

    assert.deepEqual(guard.hosts(), [
      "evil.example",
      "tora-video-engine.netlify.app",
      "www.remotion.pro",
    ]);
    assert.deepEqual(guard.log(), [
      {
        method: "POST",
        url: TELEMETRY,
        host: "www.remotion.pro",
        bytes: 200,
        allowlisted: "remotion-register-usage-point",
      },
      {
        method: "PUT",
        url: "https://evil.example/up",
        host: "evil.example",
        bytes: PNG.length,
        violation: "request body contains a PNG signature",
      },
    ]);
    assert.deepEqual(guard.violations(), [
      "PUT https://evil.example/up: request body contains a PNG signature",
    ]);
  });

  it("never throws from the listener, even when the body cannot be read", () => {
    const context = new EventEmitter();
    const guard = attachNetworkGuard(context);

    context.emit("request", {
      method: () => "POST",
      url: () => "https://x.example/p",
      postDataBuffer: () => {
        throw new Error("gone");
      },
    });

    assert.deepEqual(guard.violations(), [
      "POST https://x.example/p: POST is not allowed (only the Remotion register-usage-point telemetry POST is)",
    ]);
  });

  it("returns copies, not the internal arrays", () => {
    const context = new EventEmitter();
    const guard = attachNetworkGuard(context);

    guard.violations().push("x");
    guard.log().push({});

    assert.deepEqual(guard.violations(), []);
    assert.deepEqual(guard.log(), []);
  });
});

describe("GATE-001 G6 saveNetworkLog", () => {
  it("merges guards under their label into artifacts/network.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gate-net-"));

    try {
      const path = join(dir, "network.json");
      const context = new EventEmitter();
      const guard = attachNetworkGuard(context);

      context.emit("request", fakeRequest({method: "POST", url: TELEMETRY, body: Buffer.alloc(1)}));
      await saveNetworkLog(path, "A:gate", guard);
      await saveNetworkLog(path, "B:gate", guard);

      const saved = JSON.parse(await readFile(path, "utf8"));

      assert.deepEqual(Object.keys(saved), ["A:gate", "B:gate"]);
      assert.equal(saved["A:gate"].log.length, 1);
      assert.deepEqual(saved["A:gate"].hosts, ["www.remotion.pro"]);
      assert.deepEqual(saved["A:gate"].violations, []);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});

describe("GATE-001 G6 combineGuards", () => {
  it("merges several contexts' guards into one", () => {
    const first = new EventEmitter();
    const second = new EventEmitter();
    const a = attachNetworkGuard(first);
    const b = attachNetworkGuard(second);

    first.emit("request", fakeRequest({url: `${APP}/index.html`}));
    first.emit("request", fakeRequest({method: "POST", url: TELEMETRY, body: Buffer.alloc(3)}));
    second.emit("request", fakeRequest({url: "https://other.example/x"}));
    second.emit("request", fakeRequest({method: "PUT", url: "https://evil.example/up", body: PNG}));

    const all = combineGuards([a, b]);

    assert.deepEqual(all.hosts(), [
      "evil.example",
      "other.example",
      "tora-video-engine.netlify.app",
      "www.remotion.pro",
    ]);
    assert.equal(all.log().length, 2);
    assert.equal(all.violations().length, 1);
    assert.match(all.violations()[0], /^PUT https:\/\/evil\.example\/up/);
  });

  it("sees guards added later", () => {
    const guards = [];
    const all = combineGuards(guards);
    const context = new EventEmitter();

    guards.push(attachNetworkGuard(context));
    context.emit("request", fakeRequest({method: "DELETE", url: `${APP}/x`}));

    assert.equal(all.violations().length, 1);
  });
});

describe("GATE-001 G6 summarizeNetwork", () => {
  it("groups identical requests", () => {
    const context = new EventEmitter();
    const guard = attachNetworkGuard(context);

    for (let count = 0; count < 3; count += 1) {
      context.emit("request", fakeRequest({method: "POST", url: TELEMETRY, body: Buffer.alloc(120)}));
    }

    context.emit("request", fakeRequest({url: `${APP}/index.html`}));

    assert.equal(
      summarizeNetwork(guard),
      `3 non-GET request(s) (3 x POST ${TELEMETRY}, 120 B); hosts: tora-video-engine.netlify.app, www.remotion.pro; 0 violation(s)`,
    );
  });

  it("says so when there are none", () => {
    assert.equal(
      summarizeNetwork(attachNetworkGuard(new EventEmitter())),
      "0 non-GET request(s); hosts: none; 0 violation(s)",
    );
  });
});
