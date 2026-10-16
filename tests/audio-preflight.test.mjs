import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {describe, it} from "node:test";
import {
  AUDIO_PREFLIGHT_KILL_GRACE_MS,
  AUDIO_PREFLIGHT_TIMEOUT_MS,
  checkAudioFileDecodes,
  createWavDataCounter,
  decodeAudioFileWithFfmpeg,
} from "../scripts/audioPreflight.ts";
import {inspectAudio} from "../src/localAssets/audioInspection.ts";
import {fixtureBytes} from "./helpers/audioBytes.mjs";
import {
  FAKE_FFMPEG as FFMPEG,
  fakeSpawn,
  succeedWith,
  wavStream,
} from "./helpers/fakeFfmpeg.mjs";

const fixturePath = (name) =>
  fileURLToPath(new URL(`./fixtures/local-audio/${name}`, import.meta.url));

describe("createWavDataCounter", () => {
  it("counts only the bytes after the data chunk header, whatever the chunk boundaries", () => {
    const wav = wavStream(1);

    for (const chunkSize of [1, 7, 44, 45, 1000, wav.length]) {
      const counter = createWavDataCounter();

      for (let offset = 0; offset < wav.length; offset += chunkSize) {
        counter.push(wav.subarray(offset, offset + chunkSize));
      }

      assert.equal(counter.dataBytes, 96_000, `chunk size ${chunkSize}`);
    }
  });

  it("skips extra header chunks such as LIST", () => {
    const base = wavStream(0.5);
    const list = Buffer.alloc(8 + 26);

    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(26, 4);

    const wav = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
    const counter = createWavDataCounter();

    counter.push(wav);
    assert.equal(counter.dataBytes, 48_000);
  });

  it("rejects a stream that is not a WAV", () => {
    assert.throws(
      () => createWavDataCounter().push(Buffer.from("not a wav stream at all")),
      /did not write a WAV stream/u,
    );
  });
});

describe("decodeAudioFileWithFfmpeg with an injected spawn", () => {
  it("runs the repository ffmpeg on the first audio stream, mono 48 kHz, bounded, never reading stdin", async () => {
    const calls = [];
    const result = await decodeAudioFileWithFfmpeg("/staged/voice.wav", {
      spawn: fakeSpawn(succeedWith(wavStream(2.2)), calls),
      ffmpeg: FFMPEG,
    });

    assert.equal(result.ok, true);
    assert.ok(Math.abs(result.decodedSeconds - 2.2) < 1e-9);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "ffmpeg-under-test");
    assert.deepEqual(calls[0].args, [
      "-v",
      "error",
      "-nostdin",
      "-i",
      "file:/staged/voice.wav",
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-t",
      "301",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      "-",
    ]);
    assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  });

  it("passes a path that starts with a dash as a file: input, never as an option", async () => {
    const calls = [];

    await decodeAudioFileWithFfmpeg("-stats.wav", {
      spawn: fakeSpawn(succeedWith(wavStream(0.1)), calls),
      ffmpeg: FFMPEG,
    });
    assert.equal(calls[0].args[calls[0].args.indexOf("-i") + 1], "file:-stats.wav");
  });

  it("attaches the child to the interrupt guard before it can produce anything", async () => {
    const attached = [];
    const calls = [];

    await decodeAudioFileWithFfmpeg("/staged/a.wav", {
      spawn: fakeSpawn(succeedWith(wavStream(0.1)), calls),
      ffmpeg: FFMPEG,
      control: {attach: (child) => attached.push(child)},
    });
    assert.equal(attached.length, 1);
    assert.equal(attached[0], calls[0].child);
  });

  it("stops ffmpeg that decodes more than the bound (a container that lies about its length)", async () => {
    const calls = [];
    const result = await decodeAudioFileWithFfmpeg("/staged/liar.mp3", {
      spawn: fakeSpawn((child) => {
        const header = wavStream(0).subarray(0, 44);
        const second = Buffer.alloc(96_000);

        child.stdout.emit("data", header);

        // 303 s is past the bound of 301 s plus one second of slack.
        for (let index = 0; index < 304 && !child.killed; index += 1) {
          child.stdout.emit("data", second);
        }
      }, calls, {closeOnKill: true}),
      ffmpeg: FFMPEG,
    });

    assert.deepEqual([result.ok, result.reason], [false, "output"]);
    assert.match(result.detail, /more than 301 s/u);
    assert.equal(calls[0].child.killed, true);
  });

  it("fails on a non-zero exit and keeps the first lines of stderr", async () => {
    const result = await decodeAudioFileWithFfmpeg("/staged/a.mp3", {
      spawn: fakeSpawn((child) => {
        child.stderr.emit("data", Buffer.from("Invalid data found when processing input"));
        child.emit("close", 1, null);
      }),
      ffmpeg: FFMPEG,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "exit");
    assert.match(result.detail, /exited with code 1: Invalid data found/u);
  });

  it("kills ffmpeg and fails when it does not finish within the timeout", async () => {
    const calls = [];
    const result = await decodeAudioFileWithFfmpeg("/staged/a.mp3", {
      spawn: fakeSpawn(() => undefined, calls, {closeOnKill: true}),
      ffmpeg: FFMPEG,
      timeoutMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "timeout");
    assert.equal(calls[0].child.killed, true);
    assert.equal(AUDIO_PREFLIGHT_TIMEOUT_MS, 60_000);
    assert.equal(AUDIO_PREFLIGHT_KILL_GRACE_MS, 2_000);
  });

  it("reports a timeout only after the killed child has closed, so the caller can remove the staged file", async () => {
    const calls = [];
    const order = [];
    const pending = decodeAudioFileWithFfmpeg("/staged/a.mp3", {
      spawn: fakeSpawn(() => undefined, calls),
      ffmpeg: FFMPEG,
      timeoutMs: 20,
    }).then((result) => {
      order.push("settled");

      return result;
    });

    while (calls.length === 0 || !calls[0].child.killed) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Killed, but not closed yet: still unsettled well past the timeout.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(order, []);
    order.push("closed");
    calls[0].child.emit("close", null, "SIGTERM");

    const result = await pending;

    assert.deepEqual(order, ["closed", "settled"]);
    assert.deepEqual([result.ok, result.reason], [false, "timeout"]);
    assert.match(result.detail, /did not finish within 0\.02 s/u);
  });

  it("reports the output bound only after the killed child has closed", async () => {
    const calls = [];
    const order = [];
    const pending = decodeAudioFileWithFfmpeg("/a", {
      spawn: fakeSpawn(
        (child) => child.stdout.emit("data", Buffer.from("garbage garbage garbage")),
        calls,
      ),
      ffmpeg: FFMPEG,
    }).then((result) => {
      order.push("settled");

      return result;
    });

    while (calls.length === 0 || !calls[0].child.killed) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(order, []);
    order.push("closed");
    calls[0].child.emit("close", null, "SIGTERM");
    // Output that arrives while the child is dying changes nothing.
    calls[0].child.stdout.emit("data", Buffer.alloc(10));

    const result = await pending;

    assert.deepEqual(order, ["closed", "settled"]);
    assert.deepEqual([result.ok, result.reason], [false, "output"]);
  });

  it("reports the failure anyway after the grace when the killed child never closes", async () => {
    const calls = [];
    const started = Date.now();
    const result = await decodeAudioFileWithFfmpeg("/staged/a.mp3", {
      spawn: fakeSpawn(() => undefined, calls),
      ffmpeg: FFMPEG,
      timeoutMs: 10,
      killGraceMs: 80,
    });

    assert.deepEqual([result.ok, result.reason], [false, "timeout"]);
    assert.equal(calls[0].child.killed, true);
    assert.ok(Date.now() - started >= 80, `settled after ${Date.now() - started} ms`);
  });

  it("fails when ffmpeg cannot be started, whether spawn throws or emits an error", async () => {
    const thrown = await decodeAudioFileWithFfmpeg("/a", {
      spawn: () => {
        throw new Error("ENOENT");
      },
      ffmpeg: FFMPEG,
    });
    const emitted = await decodeAudioFileWithFfmpeg("/a", {
      spawn: fakeSpawn((child) => child.emit("error", new Error("spawn EACCES"))),
      ffmpeg: FFMPEG,
    });

    assert.deepEqual([thrown.ok, thrown.reason], [false, "spawn"]);
    assert.deepEqual([emitted.ok, emitted.reason], [false, "spawn"]);
  });

  it("fails when the output is not a WAV stream, and stops ffmpeg", async () => {
    const calls = [];
    const result = await decodeAudioFileWithFfmpeg("/a", {
      spawn: fakeSpawn(
        (child) => child.stdout.emit("data", Buffer.from("garbage garbage garbage")),
        calls,
        {closeOnKill: true},
      ),
      ffmpeg: FFMPEG,
    });

    assert.deepEqual([result.ok, result.reason], [false, "output"]);
    assert.equal(calls[0].child.killed, true);
  });
});

describe("checkAudioFileDecodes applies the D-9 truncation rule", () => {
  const check = (decodedSeconds, durationSeconds) =>
    checkAudioFileDecodes("/staged/a.wav", durationSeconds, {
      spawn: fakeSpawn(succeedWith(wavStream(decodedSeconds))),
      ffmpeg: FFMPEG,
    });

  it("passes a decode 0.2 s short and refuses one 0.3 s short of the inspected duration", async () => {
    assert.equal((await check(9.8, 10)).ok, true);

    const short = await check(9.7, 10);

    assert.equal(short.ok, false);
    assert.match(short.detail, /only 9\.70 s of 10\.00 s could be decoded/u);
  });

  it("refuses exit 0 with zero decoded bytes, which is what a 0.12 s clip that decodes to nothing looks like", async () => {
    const result = await checkAudioFileDecodes("/staged/pop.wav", 0.12, {
      spawn: fakeSpawn(succeedWith(wavStream(0))),
      ffmpeg: FFMPEG,
    });

    assert.equal(result.ok, false);
    assert.match(result.detail, /only 0\.00 s of 0\.12 s/u);
  });

  it("passes a non-zero decode of a short clip and passes the clip when everything decodes", async () => {
    assert.equal((await check(0.11, 0.12)).ok, true);
    assert.equal((await check(0.12, 0.12)).ok, true);
  });

  it("returns the process failure as the detail", async () => {
    const result = await checkAudioFileDecodes("/staged/a.mp3", 5, {
      spawn: fakeSpawn((child) => child.emit("close", 2, null)),
      ffmpeg: FFMPEG,
    });

    assert.equal(result.ok, false);
    assert.match(result.detail, /exited with code 2/u);
  });
});

describe("checkAudioFileDecodes with the real ffmpeg on the fixtures", () => {
  const durationOf = async (name) => {
    const inspected = await inspectAudio(fixtureBytes(name));

    assert.equal(inspected.ok, true, name);

    return inspected.metadata.durationSeconds;
  };

  for (const name of [
    "tone-440-2.2s.mp3",
    "tone-440-2.2s.wav",
    "tone-440-2.2s.m4a",
    "tone-440-2.2s.opus.ogg",
    "tone-880-0.4s.mp3",
  ]) {
    it(`decodes ${name} completely`, async () => {
      const result = await checkAudioFileDecodes(fixturePath(name), await durationOf(name));

      assert.equal(result.ok, true, JSON.stringify(result));
    });
  }

  it("refuses the truncated MP3 whose header still declares 10 s (about 6 s decode)", async () => {
    const result = await checkAudioFileDecodes(
      fixturePath("truncated.mp3"),
      await durationOf("truncated.mp3"),
    );

    assert.equal(result.ok, false);
    assert.match(result.detail, /only 5\.\d\d s of 10\.0\d s could be decoded/u);
  });

  it("refuses a file ffmpeg cannot read", async () => {
    const result = await checkAudioFileDecodes(fixturePath("not-audio.txt"), 1);

    assert.equal(result.ok, false);
    assert.match(result.detail, /exited with code/u);
  });

  it("decodes the 301 s MP3 fixture without buffering it", async () => {
    const result = await decodeAudioFileWithFfmpeg(fixturePath("long-301s.mp3"));

    assert.equal(result.ok, true);
    assert.ok(Math.abs(result.decodedSeconds - 301) < 1, `${result.decodedSeconds}`);
  });
});
