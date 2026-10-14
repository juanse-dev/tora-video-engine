import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {describe, it} from "node:test";

const readJson = async (path) =>
  JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));

describe("AUDIO-002 dependencies", () => {
  it("pins @remotion/media and mediabunny exactly, as direct dependencies", async () => {
    const pkg = await readJson("package.json");

    assert.equal(pkg.dependencies["@remotion/media"], "4.0.529");
    assert.equal(pkg.dependencies.mediabunny, "1.56.1");
  });

  it("keeps every Remotion package on the same exact version", async () => {
    const pkg = await readJson("package.json");

    for (const name of [
      "remotion",
      "@remotion/cli",
      "@remotion/player",
      "@remotion/web-renderer",
      "@remotion/media",
    ]) {
      assert.equal(pkg.dependencies[name], "4.0.529", name);
    }
  });

  it("locks the same versions at the root and in node_modules", async () => {
    const lock = await readJson("package-lock.json");
    const root = lock.packages[""].dependencies;

    assert.equal(root["@remotion/media"], "4.0.529");
    assert.equal(root.mediabunny, "1.56.1");
    assert.equal(lock.packages["node_modules/@remotion/media"].version, "4.0.529");
    assert.equal(lock.packages["node_modules/mediabunny"].version, "1.56.1");
  });
});
