import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {describe, it} from "node:test";

const read = (path) => readFile(path, "utf8");

describe("WEB-007 static deployment contract", () => {
  it("keeps Netlify on the shared production web build and deploy directory", async () => {
    const netlify = await read("netlify.toml");

    assert.match(netlify, /command\s*=\s*"npm run web:build"/);
    assert.match(netlify, /publish\s*=\s*"dist\/web"/);
    assert.match(netlify, /NODE_VERSION\s*=\s*"22"/);
    assert.doesNotMatch(netlify, /\[functions\]/);
  });

  it("keeps the Vite production app root-hosted in dist/web", async () => {
    const vite = await read("vite.config.mts");
    const packageJson = JSON.parse(await read("package.json"));

    assert.match(vite, /base:\s*"\/"/);
    assert.match(vite, /outDir:\s*"dist\/web"/);
    assert.equal(packageJson.scripts["web:build"], "vite build");
  });

  it("does not add a speculative SPA catch-all for the single root route", async () => {
    const netlify = await read("netlify.toml");

    assert.doesNotMatch(netlify, /\[\[redirects\]\]/);
  });
});
