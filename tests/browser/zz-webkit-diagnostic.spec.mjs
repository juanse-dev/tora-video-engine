// TEMPORARY diagnostic for the webkit startup failure. Reverted after use.
import {test} from "@playwright/test";

test("diagnose app startup", async ({page, browserName}) => {
  const log = [];

  page.on("console", (m) => log.push(`console.${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => log.push(`pageerror: ${e.message}\n${e.stack}`));
  page.on("requestfailed", (r) =>
    log.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`),
  );
  page.on("response", (r) => {
    if (r.status() >= 400) log.push(`response ${r.status()}: ${r.url()}`);
  });

  const response = await page.goto("/", {waitUntil: "domcontentloaded"});

  await page.waitForTimeout(8000);

  const info = await page.evaluate(async () => {
    const shell = document.querySelector(".app-shell");
    const out = {
      hasShell: shell !== null,
      mode: shell?.getAttribute("data-persistence-mode") ?? null,
      locks: typeof navigator.locks,
      locksRequest: typeof navigator.locks?.request,
      indexedDB: typeof indexedDB,
      broadcast: typeof BroadcastChannel,
      cryptoSubtle: typeof crypto?.subtle,
      html: document.documentElement.outerHTML.slice(0, 1200),
      ua: navigator.userAgent,
      secure: window.isSecureContext,
    };

    try {
      out.lockProbe = await new Promise((resolve) => {
        const t = setTimeout(() => resolve("timeout"), 3000);

        navigator.locks
          .request("diag", {mode: "exclusive", ifAvailable: true}, async (l) => {
            clearTimeout(t);
            resolve(l === null ? "null-lock" : "granted");
          })
          .catch((e) => {
            clearTimeout(t);
            resolve(`rejected: ${e}`);
          });
      });
    } catch (e) {
      out.lockProbe = `threw: ${e}`;
    }

    return out;
  });

  throw new Error(
    `DIAG ${browserName} status=${response?.status()}\n${JSON.stringify(info, null, 2)}\n${log.join("\n")}`,
  );
});
