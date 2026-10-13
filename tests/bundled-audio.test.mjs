import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, describe, it} from "node:test";
import {bundledAudioCatalog} from "../src/audio/catalog.ts";

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const licenses = readFileSync("public/audio/LICENSES.md", "utf8");
const effectIds = ["whoosh", "boom", "ding", "pop"];

describe("bundled audio files", () => {
  const outputs = [];
  const generate = () => {
    const out = mkdtempSync(join(tmpdir(), "tora-sfx-"));
    outputs.push(out);
    execFileSync(process.execPath, ["scripts/generateBundledAudio.mjs", out]);
    return out;
  };
  after(() => {
    for (const dir of outputs) rmSync(dir, {recursive: true, force: true});
  });

  for (const entry of Object.values(bundledAudioCatalog)) {
    if (entry.file === null) continue;
    it(`${entry.id}: file exists and has a LICENSES row`, () => {
      assert.ok(existsSync(join("public", entry.file)));
      assert.ok(licenses.includes(`| ${entry.id} | ${entry.file} |`), `${entry.id} has no LICENSES row`);
    });
  }

  // Only the synthesized effects are WAVs; owner-supplied music may be MP3, M4A or Ogg (task 7).
  for (const id of effectIds) {
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

  for (const id of effectIds) {
    it(`${id}: sample peak is between -6 and -0.5 dBFS, without clipping`, () => {
      const bytes = readFileSync(join("public", bundledAudioCatalog[id].file));
      const start = bytes.indexOf("data") + 8;
      let peak = 0;
      for (let i = start; i + 1 < bytes.length; i += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));
      const dbfs = 20 * Math.log10(peak / 32_768);
      assert.ok(peak < 32_767, `${id} clips`);
      assert.ok(dbfs >= -6 && dbfs <= -0.5, `${id} peak ${dbfs.toFixed(2)} dBFS`);
    });
  }

  it("the generator is deterministic: two runs write byte-identical files", () => {
    const first = generate();
    const second = generate();
    for (const id of effectIds) {
      assert.equal(sha(join(first, `${id}.wav`)), sha(join(second, `${id}.wav`)), id);
    }
  });

  it("a fresh run matches the committed files (same header, every sample within 1 LSB)", () => {
    const out = generate();
    for (const id of effectIds) {
      const fresh = join(out, `${id}.wav`);
      const committed = join("public/audio/sfx", `${id}.wav`);
      if (sha(fresh) === sha(committed)) continue;
      const a = readFileSync(fresh);
      const b = readFileSync(committed);
      const start = a.indexOf("data") + 8;
      assert.equal(a.length, b.length, `${id}: length differs`);
      assert.deepEqual(a.subarray(0, start), b.subarray(0, start), `${id}: header differs`);
      for (let at = start; at + 1 < a.length; at += 2) {
        assert.ok(
          Math.abs(a.readInt16LE(at) - b.readInt16LE(at)) <= 1,
          `${id}: sample ${(at - start) / 2} differs by more than 1 LSB (${a.readInt16LE(at)} vs ${b.readInt16LE(at)})`,
        );
      }
    }
  });
});
