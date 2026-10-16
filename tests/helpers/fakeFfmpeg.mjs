// A fake `child_process.spawn` for the CLI audio preflight (scripts/audioPreflight.ts):
// the tests decide what the "ffmpeg" writes and how it exits.

import {EventEmitter} from "node:events";
import {buildWav} from "./audioBytes.mjs";

export const FAKE_FFMPEG = {ffmpeg: "ffmpeg-under-test", dir: "dir-under-test"};

/**
 * A fake `spawn`. After the call, `script(child, call)` emits what the fake
 * ffmpeg does (`child.stdout` / `child.stderr` data, then `close`). Every call
 * is appended to `calls`; `calls.active` is the number of children that were
 * started and have not closed (a test can assert it never exceeds 1). With
 * `{closeOnKill: true}` the fake child closes (asynchronously, like a real process)
 * after `kill()`; by default it never does.
 */
export const fakeSpawn = (script, calls = [], {closeOnKill = false} = {}) => {
  calls.active = 0;
  calls.maxActive = 0;

  return (command, args, options) => {
    const child = new EventEmitter();
    const call = {command, args, options, child};

    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;

      if (closeOnKill) {
        setImmediate(() => child.emit("close", null, "SIGTERM"));
      }
    };
    child.once("close", () => {
      calls.active -= 1;
    });
    calls.active += 1;
    calls.maxActive = Math.max(calls.maxActive, calls.active);
    calls.push(call);
    setImmediate(() => script(child, call));

    return child;
  };
};

/** A 48 kHz mono 16-bit WAV stream: a 44-byte header followed by `seconds` of silence. */
export const wavStream = (seconds) =>
  buildWav({sampleRate: 48_000, channels: 1, seconds});

/** The script of an ffmpeg that writes `bytes` in chunks and exits 0. */
export const succeedWith = (bytes, chunkSize = 4096) => (child) => {
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    child.stdout.emit("data", bytes.subarray(offset, offset + chunkSize));
  }

  child.emit("close", 0, null);
};

/** The script of an ffmpeg that decodes `seconds` of audio and exits 0. */
export const decodeSeconds = (seconds) => succeedWith(wavStream(seconds));
