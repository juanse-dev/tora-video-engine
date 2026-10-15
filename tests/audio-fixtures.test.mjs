import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync, readFileSync, readdirSync, rmSync, statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, before, describe, it} from "node:test";
import {
  fixtureFiles,
  generateAudioFixtures,
  patchWavChannels,
} from "../scripts/generateAudioFixtures.mjs";
import {fixtureBytes, readWavHeader} from "./helpers/audioBytes.mjs";

const DIR = "tests/fixtures/local-audio";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Parses the leading ID3v2 tag, the first MP3 frame header and the Xing/Info tag
// that follows its side information (bytes only, no decoder).
const mp3Header = (bytes) => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let frame = 0;

  if (buffer.toString("latin1", 0, 3) === "ID3") {
    frame = 10 + ((buffer[6] << 21) | (buffer[7] << 14) | (buffer[8] << 7) | buffer[9]);
  }

  assert.equal(buffer[frame], 0xff, "MP3 frame sync");
  assert.equal(buffer[frame + 1] & 0xe0, 0xe0, "MP3 frame sync");

  const versionBits = (buffer[frame + 1] >> 3) & 3;
  const mpeg1 = versionBits === 3;
  const rates = {3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8_000]}[versionBits];
  const mono = buffer[frame + 3] >> 6 === 3;
  const tagOffset = frame + 4 + (mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17));
  const tag = buffer.toString("latin1", tagOffset, tagOffset + 4);
  const flags = buffer.readUInt32BE(tagOffset + 4);

  return {
    channels: mono ? 1 : 2,
    sampleRate: rates[(buffer[frame + 2] >> 2) & 3],
    tagOffset,
    tag,
    frames: flags & 1 ? buffer.readUInt32BE(tagOffset + 8) : null,
  };
};
const wavSamples = (bytes) => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = buffer.indexOf("data") + 8;

  return {buffer, start};
};

describe("committed audio fixtures", () => {
  const outputs = [];
  let first;
  let second;

  const generate = () => {
    const out = mkdtempSync(join(tmpdir(), "tora-audio-fixtures-"));

    outputs.push(out);
    generateAudioFixtures(out);

    return out;
  };

  before(() => {
    first = generate();
    second = generate();
  });
  after(() => {
    for (const dir of outputs) rmSync(dir, {recursive: true, force: true});
  });

  it("lists exactly the committed files", () => {
    assert.deepEqual(readdirSync(DIR).filter((name) => name !== "README.md").sort(), [...fixtureFiles].sort());
  });

  it("has no Ogg Vorbis fixture (the repository ffmpeg cannot encode Vorbis)", () => {
    assert.equal(fixtureFiles.some((name) => /vorbis/iu.test(name)), false);
  });

  it("keeps the committed fixtures small enough to review (under 8 MiB in total)", () => {
    const total = fixtureFiles.reduce((sum, name) => sum + statSync(join(DIR, name)).size, 0);

    assert.ok(total < 8 * 1024 * 1024, `${total} bytes`);
  });

  it("the generator is deterministic: two runs write byte-identical files", () => {
    for (const name of fixtureFiles) {
      assert.equal(sha(readFileSync(join(first, name))), sha(readFileSync(join(second, name))), name);
    }
  });

  it("a fresh run matches every committed PCM fixture (same header, every sample within 1 LSB)", () => {
    for (const name of fixtureFiles.filter((file) => file.endsWith(".wav"))) {
      const a = wavSamples(readFileSync(join(first, name)));
      const b = wavSamples(readFileSync(join(DIR, name)));

      assert.equal(a.buffer.length, b.buffer.length, `${name}: length`);
      assert.deepEqual(a.buffer.subarray(0, a.start), b.buffer.subarray(0, b.start), `${name}: header`);

      for (let at = a.start; at + 1 < a.buffer.length; at += 2) {
        const delta = Math.abs(a.buffer.readInt16LE(at) - b.buffer.readInt16LE(at));

        if (delta > 1) assert.fail(`${name}: sample ${(at - a.start) / 2} differs by ${delta}`);
      }
    }
  });

  it("the tone WAVs have the documented format, length and a full-scale peak", () => {
    const expected = [
      ["tone-220-10s.wav", 2, 480_000],
      ["tone-440-2.2s.wav", 2, 105_600],
      ["tone-880-0.4s.wav", 2, 19_200],
      ["tone-220-12s.wav", 2, 576_000],
      ["mono-440.wav", 1, 105_600],
      ["three-channel.wav", 3, 19_200],
    ];

    for (const [name, channels, frames] of expected) {
      const header = readWavHeader(fixtureBytes(name));

      assert.equal(header.channels, channels, name);
      assert.equal(header.sampleRate, 48_000, name);
      assert.equal(header.bitsPerSample, 16, name);
      assert.equal(header.frames, frames, name);

      const {buffer, start} = wavSamples(fixtureBytes(name));
      let peak = 0;

      for (let at = start; at + 1 < buffer.length; at += 2) peak = Math.max(peak, Math.abs(buffer.readInt16LE(at)));

      if (peak < 32_000) assert.fail(`${name}: peak ${peak} is not full scale`);
    }
  });

  it("zero-channel.wav is mono-440.wav with only the fmt channel field patched to 0", () => {
    const mono = fixtureBytes("mono-440.wav");
    const zero = fixtureBytes("zero-channel.wav");

    assert.equal(readWavHeader(zero).channels, 0);
    assert.deepEqual(Buffer.from(zero), patchWavChannels(mono, 0));
    assert.deepEqual(Buffer.from(zero.subarray(24)), Buffer.from(mono.subarray(24)));
  });

  it("truncated.mp3 is the first 60% of the 10 s MP3", () => {
    const full = fixtureBytes("tone-220-10s.mp3");
    const cut = fixtureBytes("truncated.mp3");

    assert.equal(cut.length, Math.floor(full.length * 0.6));
    assert.deepEqual(Buffer.from(cut), Buffer.from(full.subarray(0, cut.length)));
  });

  it("truncated.mp3 still carries the Info/Xing tag of the full file (declares 10 s)", () => {
    const full = mp3Header(fixtureBytes("tone-220-10s.mp3"));
    const cut = mp3Header(fixtureBytes("truncated.mp3"));

    assert.ok(["Info", "Xing"].includes(cut.tag), cut.tag);
    assert.equal(cut.tagOffset, 56);
    assert.equal(cut.tagOffset, full.tagOffset);
    assert.equal(cut.frames, full.frames);
    // 1152 samples per frame at 44.1 kHz: more than 300 frames is more than 7.8 s.
    assert.ok(cut.frames > 300, `${cut.frames} frames`);
  });

  it("long-301s.mp3 is 8 kHz mono", () => {
    const header = mp3Header(fixtureBytes("long-301s.mp3"));

    assert.equal(header.channels, 1);
    assert.equal(header.sampleRate, 8_000);
  });

  it("not-audio.txt is plain text", () => {
    assert.equal(new TextDecoder().decode(fixtureBytes("not-audio.txt")), "This is not an audio file.\n");
  });

  it("with-video.mp4 and the lossy fixtures carry their container signatures", () => {
    const ascii = (name, from, to) => Buffer.from(fixtureBytes(name).subarray(from, to)).toString("latin1");

    assert.equal(ascii("with-video.mp4", 4, 8), "ftyp");
    assert.equal(ascii("tone-220-10s.m4a", 4, 8), "ftyp");
    assert.equal(ascii("tone-220-10s.opus.ogg", 0, 4), "OggS");
    assert.ok(["ID3", "\xff\xfb", "\xff\xf3", "\xff\xf2"].some((sig) => ascii("tone-220-10s.mp3", 0, sig.length) === sig));
  });
});
