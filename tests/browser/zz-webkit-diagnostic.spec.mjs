// TEMPORARY diagnostic for the webkit startup failure. Reverted after use.
import {test} from "@playwright/test";

const within = (promise, ms, label) =>
  Promise.race([
    promise.then(
      (value) => ({label, value}),
      (error) => ({label, error: String(error)}),
    ),
    new Promise((resolve) => setTimeout(() => resolve({label, hung: ms}), ms)),
  ]);

const HEARTBEAT = () => {
  const t0 = performance.now();
  let n = 0;
  const id = setInterval(() => {
    n += 1;
    console.log(`hb ${n} t=${Math.round(performance.now() - t0)}`);
    if (n >= 20) clearInterval(id);
  }, 250);
};

const VARIANTS = {
  control_blank: null,
  app_plain: () => {},
  app_no_webgl: () => {
    const original = HTMLCanvasElement.prototype.getContext;

    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (/webgl/u.test(type)) {
        console.log(`getContext(${type}) -> null`);
        return null;
      }
      return original.call(this, type, ...rest);
    };
  },
  app_no_webcodecs: () => {
    for (const name of [
      "VideoEncoder",
      "VideoDecoder",
      "AudioEncoder",
      "AudioDecoder",
      "VideoFrame",
      "AudioData",
    ]) {
      console.log(`${name}: ${typeof window[name]}`);
      delete window[name];
    }
  },
  app_trace_webgl: () => {
    const original = HTMLCanvasElement.prototype.getContext;

    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      console.log(`getContext(${type}) begin`);
      const result = original.call(this, type, ...rest);
      console.log(`getContext(${type}) end ${result === null ? "null" : "ctx"}`);
      return result;
    };
    for (const name of ["VideoEncoder", "VideoDecoder", "AudioEncoder", "AudioDecoder", "OffscreenCanvas"]) {
      console.log(`${name}: ${typeof window[name]}`);
    }
  },
};

for (const [name, variant] of Object.entries(VARIANTS)) {
  test(`diagnose ${name}`, async ({browser, browserName}) => {
    test.setTimeout(60_000);

    const context = await browser.newContext({baseURL: "http://127.0.0.1:4173"});
    const page = await context.newPage();
    const log = [];
    const steps = [];

    page.on("console", (m) => log.push(`${m.type()}: ${m.text()}`));
    page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
    page.on("crash", () => log.push("PAGE CRASH"));
    await page.addInitScript(HEARTBEAT);
    if (variant !== null) await page.addInitScript(variant);
    if (variant === null) {
      await page.route("**/__blank", (route) =>
        route.fulfill({contentType: "text/html", body: "<p>blank</p>"}),
      );
    }

    steps.push(
      await within(
        page
          .goto(variant === null ? "/__blank" : "/", {waitUntil: "domcontentloaded"})
          .then((r) => r?.status()),
        10000,
        "goto",
      ),
    );
    await page.waitForTimeout(4000);
    steps.push(
      await within(
        page.evaluate(() => ({
          locks: typeof navigator.locks,
          secure: window.isSecureContext,
          shell:
            document
              .querySelector(".app-shell")
              ?.getAttribute("data-persistence-mode") ?? null,
        })),
        4000,
        "env",
      ),
    );

    // Bound the output: heartbeat lines only first/last few.
    const hb = log.filter((l) => l.includes("hb "));
    const other = log.filter((l) => !l.includes("hb "));

    throw new Error(
      `DIAG ${browserName} ${name}\n${JSON.stringify(steps)}\nheartbeats=${hb.length} last=${hb.at(-1)}\n${other.join("\n")}`,
    );
  });
}
