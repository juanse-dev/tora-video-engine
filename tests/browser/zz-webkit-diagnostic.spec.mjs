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

test("diagnose app startup", async ({page, browserName}) => {
  test.setTimeout(90_000);

  const log = [];
  const steps = [];

  page.on("console", (m) => log.push(`console.${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => log.push(`pageerror: ${e.message}\n${e.stack}`));
  page.on("crash", () => log.push("PAGE CRASH"));
  page.on("requestfailed", (r) =>
    log.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`),
  );
  page.on("response", (r) => {
    if (r.status() >= 400) log.push(`response ${r.status()}: ${r.url()}`);
  });

  steps.push(
    await within(
      page.goto("/", {waitUntil: "domcontentloaded"}).then((r) => r?.status()),
      15000,
      "goto",
    ),
  );
  await page.waitForTimeout(3000);
  steps.push(await within(page.evaluate(() => 1 + 1), 4000, "eval 1+1"));
  steps.push(
    await within(
      page.evaluate(() => ({
        locks: typeof navigator.locks,
        secure: window.isSecureContext,
        origin: location.origin,
        indexedDB: typeof indexedDB,
        broadcast: typeof BroadcastChannel,
        ua: navigator.userAgent,
        readyState: document.readyState,
        hasRoot: document.querySelector("#root") !== null,
        rootChildren: document.querySelector("#root")?.childElementCount,
        shell:
          document
            .querySelector(".app-shell")
            ?.getAttribute("data-persistence-mode") ?? null,
      })),
      4000,
      "env",
    ),
  );
  steps.push(
    await within(
      page.evaluate(
        () =>
          new Promise((resolve) => {
            if (!navigator.locks) return resolve("no navigator.locks");
            navigator.locks
              .request("diag", {mode: "exclusive", ifAvailable: true}, async (l) =>
                resolve(l === null ? "null-lock" : "granted"),
              )
              .catch((e) => resolve(`rejected: ${e}`));
          }),
      ),
      4000,
      "lock probe in app page",
    ),
  );

  // Same probes on a fresh page that does not load the app.
  const blank = await page.context().newPage();

  await within(blank.goto("http://127.0.0.1:4173/robots-none"), 8000, "goto404");
  steps.push(
    await within(
      blank.evaluate(
        () =>
          new Promise((resolve) => {
            const out = {
              locks: typeof navigator.locks,
              secure: window.isSecureContext,
            };

            if (!navigator.locks) return resolve(out);
            navigator.locks
              .request("diag2", {mode: "exclusive", ifAvailable: true}, async (l) =>
                resolve({...out, probe: l === null ? "null-lock" : "granted"}),
              )
              .catch((e) => resolve({...out, probe: `rejected: ${e}`}));
          }),
      ),
      4000,
      "lock probe on non-app page",
    ),
  );

  throw new Error(
    `DIAG ${browserName}\n${JSON.stringify(steps, null, 2)}\n${log.join("\n")}`,
  );
});
