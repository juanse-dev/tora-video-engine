import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {after, describe, it} from "node:test";
import {bundledAudioCatalog} from "../src/audio/catalog.ts";
import {inspectAudio} from "../src/localAssets/audioInspection.ts";
import {checkOriginals, originals, prepareBundledAudio, publishPrepared} from "../scripts/prepareBundledAudio.mjs";

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const licenses = readFileSync("public/audio/LICENSES.md", "utf8");
const effectIds = ["whoosh", "boom", "ding", "pop"];

// The CC0 originals are not committed (`.superpowers/` is in .gitignore), so CI has
// none: the reproduction test runs wherever they are on disk (TORA_SFX_ORIGINALS
// names another directory) and skips, saying why, everywhere else.
const originalsDir = resolve(process.env.TORA_SFX_ORIGINALS ?? ".superpowers/sdd/sfx-cc0/originals");
const skip = Object.values(originals).every(({file}) => existsSync(join(originalsDir, file)))
  ? false
  : `the CC0 originals are not on this machine (${originalsDir}); set TORA_SFX_ORIGINALS to a directory that holds them`;

describe("bundled audio files", () => {
  const outputs = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "tora-sfx-"));
    outputs.push(dir);
    return dir;
  };
  const prepare = (from, out) => execFileSync(process.execPath, ["scripts/prepareBundledAudio.mjs", from, out], {stdio: "pipe"});
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

  // Only the effects are WAVs; owner-supplied music may be MP3, M4A or Ogg (task 7).
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

  for (const id of effectIds) {
    it(`${id}: the catalog duration equals inspectAudio of the committed file within 1 microsecond (AINV-3)`, async () => {
      const result = await inspectAudio(readFileSync(join("public", bundledAudioCatalog[id].file)));

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.metadata.container, "wave");
      assert.equal(result.metadata.codec, "pcm");
      assert.ok(Math.abs(result.metadata.durationSeconds - bundledAudioCatalog[id].durationSeconds) < 1e-6, `${id}: ${result.metadata.durationSeconds}`);
    });
  }

  for (const id of effectIds) {
    it(`${id}: sounds on its cue and ends without a click (onset within 10 ms, first and last sample within 2 LSB of zero, whole 10 ms)`, () => {
      const bytes = readFileSync(join("public", bundledAudioCatalog[id].file));
      const start = bytes.indexOf("data") + 8;
      const frames = (bytes.length - start) / 4;
      const amplitude = (frame) => Math.max(Math.abs(bytes.readInt16LE(start + frame * 4)), Math.abs(bytes.readInt16LE(start + frame * 4 + 2)));
      let onset = 0;
      while (onset < frames && amplitude(onset) < 0.003 * 32_768) onset += 1;
      assert.ok(onset / 48 <= 10, `${id}: the first audible sample (>= -50 dBFS) is at ${(onset / 48).toFixed(1)} ms`);
      assert.ok(amplitude(0) <= 2, `${id}: first sample ${amplitude(0)}`);
      assert.ok(amplitude(frames - 1) <= 2, `${id}: last sample ${amplitude(frames - 1)}`);
      assert.equal(frames % 480, 0, `${id}: ${frames} frames is not a whole number of 10 ms`);
    });
  }

  it("refuses an original whose sha256 is not the chosen recording, and writes nothing", () => {
    const bogus = tempDir();
    const out = join(tempDir(), "sfx");
    for (const {file} of Object.values(originals)) writeFileSync(join(bogus, file), "not the recording");

    assert.throws(() => checkOriginals(bogus), /whoosh: .* has sha256 .* expected 7159ba26/);
    assert.throws(() => prepare(bogus, out), (error) => error.status === 1 && /refusing a file that is not the chosen recording/.test(String(error.stderr)));
    assert.equal(existsSync(out), false, "a refused run must not create the output directory");
  });

  it("leaves the output directory untouched when ffmpeg fails on the last effect", {skip}, () => {
    const out = join(tempDir(), "sfx");
    const failOnPop = (command, args, options) => {
      if (args.includes(join(originalsDir, originals.pop.file))) throw new Error("ffmpeg failed on pop");
      return execFileSync(command, args, options);
    };

    assert.throws(() => prepareBundledAudio(originalsDir, out, {execute: failOnPop}), /ffmpeg failed on pop/);
    assert.equal(existsSync(out), false, "three finished effects must not be copied out");
  });

  it("publishes the four effects as one set: a copy failing on the third puts the replaced files back", () => {
    const ready = tempDir();
    const out = tempDir();
    const ids = Object.keys(originals);

    for (const id of ids) {
      writeFileSync(join(ready, `${id}.wav`), `new ${id}`);
      writeFileSync(join(out, `${id}.wav`), `old ${id}`);
    }

    let copies = 0;
    const failOnThird = (from, to) => {
      copies += 1;
      if (copies === 3) {
        writeFileSync(to, "half");
        throw new Error("disk full");
      }
      writeFileSync(to, readFileSync(from));
    };

    assert.throws(() => publishPrepared(ready, out, {copy: failOnThird}), /disk full/);
    for (const id of ids) {
      assert.equal(readFileSync(join(out, `${id}.wav`), "utf8"), `old ${id}`, id);
    }
  });

  it("publishing into a new directory removes it again when a copy fails", () => {
    const ready = tempDir();
    const out = join(tempDir(), "sfx");

    for (const id of Object.keys(originals)) writeFileSync(join(ready, `${id}.wav`), id);

    assert.throws(
      () => publishPrepared(ready, out, {copy: () => { throw new Error("disk full"); }}),
      /disk full/,
    );
    assert.equal(existsSync(out), false);
  });

  it("refuses a missing original", () => {
    assert.throws(() => checkOriginals(tempDir()), /whoosh: the original 60013__qubodup__whoosh\.flac is missing/);
  });

  it("preparing the originals reproduces the committed files (same header, every sample within 1 LSB)", {skip}, () => {
    const out = tempDir();
    prepare(originalsDir, out);
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
