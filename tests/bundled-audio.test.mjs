import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync, existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "node:test";
import {bundledAudioCatalog} from "../src/audio/catalog.ts";

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const licenses = readFileSync("public/audio/LICENSES.md", "utf8");

describe("bundled audio files", () => {
  for (const entry of Object.values(bundledAudioCatalog)) {
    if (entry.file === null) continue;
    it(`${entry.id}: file exists and has a LICENSES row`, () => {
      assert.ok(existsSync(join("public", entry.file)));
      assert.match(licenses, new RegExp(`\| ${entry.id} \| ${entry.file.replace(/[.]/g, "\.")} \|`));
    });
  }

  // Only the synthesized effects are WAVs; owner-supplied music may be MP3, M4A or Ogg (task 7).
  for (const id of ["whoosh", "boom", "ding", "pop"]) {
    const entry = bundledAudioCatalog[id];
    it(`${id}: is 48 kHz stereo 16-bit PCM WAV of the catalog length`, () => {
      const bytes = readFileSync(join("public", entry.file));
      assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
      assert.equal(bytes.readUInt16LE(22), 2);       // channels
      assert.equal(bytes.readUInt32LE(24), 48_000);  // sample rate
      assert.equal(bytes.readUInt16LE(34), 16);      // bits per sample
      const dataBytes = bytes.readUInt32LE(bytes.indexOf("data") + 4);
      assert.equal(dataBytes / (48_000 * 2 * 2), entry.durationSeconds);
    });
  }

  it("the generator is deterministic and matches the committed files", () => {
    const out = mkdtempSync(join(tmpdir(), "tora-sfx-"));
    execFileSync(process.execPath, ["scripts/generateBundledAudio.mjs", out]);
    for (const id of ["whoosh", "boom", "ding", "pop"]) {
      assert.equal(sha(join(out, `${id}.wav`)), sha(join("public/audio/sfx", `${id}.wav`)), id);
    }
  });
});
