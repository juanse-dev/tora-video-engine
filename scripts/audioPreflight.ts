// CLI decode preflight (AINV-8): before Remotion is spawned, every staged audio
// file the render will read is decoded once with the ffmpeg that ships with
// Remotion, and the decoded length must satisfy the D-9 truncation rule.
// Node has no WebCodecs, but the decoder here is ffmpeg, the same family
// Remotion's own audio extraction uses.
//
// The repository ffmpeg is a minimal build: it has the `wav` muxer but no raw
// `f32le`/`s16le` one, so the file is decoded to a mono 48 kHz 16-bit WAV on
// stdout and only the bytes after the WAV header are counted (nothing is buffered).
//
// The preflight fails on a non-zero exit, on a decode that produced nothing, on
// output past the bound below, or on the D-9 truncation rule; it does not use
// `-xerror`, so a file the browser import accepts (the same tolerance) is
// accepted here too. The staged path is digest- or id-named and absolute, is
// passed with a `file:` prefix (it can never parse as an option or a protocol)
// and ffmpeg never reads stdin.

import {spawn as nodeSpawn} from "node:child_process";
import {isDecodeComplete} from "../src/audio/decodeCheck.ts";
import {MAX_AUDIO_DURATION_SECONDS} from "../src/localAssets/limits.ts";
import {resolveFfmpegBinaries} from "./ffmpegBinary.mjs";

export const AUDIO_PREFLIGHT_TIMEOUT_MS = 60_000;
export const PREFLIGHT_SAMPLE_RATE = 48_000;
/** 16-bit mono. */
const PREFLIGHT_BYTES_PER_SECOND = PREFLIGHT_SAMPLE_RATE * 2;
/** How long a killed child may take to close before its failure is reported anyway. */
export const AUDIO_PREFLIGHT_KILL_GRACE_MS = 2_000;
/** AINV-7 bounds every audio source at 300 s; a file whose container lies about its length stops here. */
export const PREFLIGHT_MAX_SECONDS = MAX_AUDIO_DURATION_SECONDS + 1;
/**
 * Decoded bytes past this (the cap plus a second of slack) stop the child: nothing is ever buffered.
 * Defence in depth: with the real ffmpeg, `-t 301` already bounds the output, so only a
 * misbehaving or fake ffmpeg can reach it.
 */
export const PREFLIGHT_MAX_DECODED_BYTES =
  (PREFLIGHT_MAX_SECONDS + 1) * PREFLIGHT_BYTES_PER_SECOND;
/** A WAV header written by ffmpeg is ~80 bytes; anything this long is not a header. */
const MAX_WAV_HEADER_BYTES = 64 * 1024;
const MAX_STDERR_CHARS = 2_000;

/** The part of a child process the preflight uses (`child_process.spawn` satisfies it). */
export type PreflightChild = {
  stdout: {on(event: "data", listener: (chunk: Uint8Array) => void): unknown} | null;
  stderr: {on(event: "data", listener: (chunk: Uint8Array) => void): unknown} | null;
  /** Present for a real child; the interrupt guard signals its process tree through it. */
  pid?: number;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "close",
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

export type PreflightSpawn = (
  command: string,
  args: string[],
  options: {
    stdio: ["ignore", "pipe", "pipe"];
    windowsHide: true;
    env: NodeJS.ProcessEnv;
  },
) => PreflightChild;

export type AudioPreflightDeps = {
  /** Replaces `child_process.spawn` (tests). */
  spawn?: PreflightSpawn;
  /** Replaces the ffmpeg lookup (tests). */
  ffmpeg?: {ffmpeg: string; dir: string};
  timeoutMs?: number;
  /**
   * After a timeout or an output overflow the child is killed and the failure is
   * reported only once it has closed, so the caller can remove the staged file
   * (Windows keeps it locked until the process is gone); after this long the
   * failure is reported anyway.
   */
  killGraceMs?: number;
  /**
   * The interrupt guard of the command (`RenderControl`): the ffmpeg child is
   * attached to it, so Ctrl+C and SIGTERM stop the decode instead of waiting for it.
   */
  control?: {attach(child: PreflightChild): void};
};

export type FfmpegDecodeResult =
  | {ok: true; decodedSeconds: number}
  | {ok: false; reason: "exit" | "timeout" | "spawn" | "output"; detail: string};

export type AudioDecodeCheck =
  | {ok: true; decodedSeconds: number}
  | {ok: false; detail: string};

const concatBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(left.length + right.length);

  joined.set(left, 0);
  joined.set(right, left.length);

  return joined;
};

/** Index of the first PCM byte once the WAV header is complete, -1 while more bytes are needed. */
const findWavDataStart = (header: Uint8Array): number => {
  if (header.length < 12) {
    return -1;
  }

  const text = (start: number, end: number) =>
    String.fromCharCode(...header.subarray(start, end));

  if (text(0, 4) !== "RIFF" || text(8, 12) !== "WAVE") {
    throw new Error("ffmpeg did not write a WAV stream");
  }

  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  let offset = 12;

  while (offset + 8 <= header.length) {
    const size = view.getUint32(offset + 4, true);

    if (text(offset, offset + 4) === "data") {
      return offset + 8;
    }

    offset += 8 + size + (size % 2);
  }

  return -1;
};

/** Counts the PCM bytes of a streamed WAV without keeping them. */
export const createWavDataCounter = () => {
  let header: Uint8Array = new Uint8Array(0);
  let headerDone = false;
  let dataBytes = 0;

  return {
    push(chunk: Uint8Array): void {
      if (headerDone) {
        dataBytes += chunk.length;

        return;
      }

      header = concatBytes(header, chunk);

      const start = findWavDataStart(header);

      if (start >= 0) {
        headerDone = true;
        dataBytes = header.length - start;
        header = new Uint8Array(0);
      } else if (header.length > MAX_WAV_HEADER_BYTES) {
        throw new Error("ffmpeg did not write a WAV header");
      }
    },
    get headerComplete(): boolean {
      return headerDone;
    },
    get dataBytes(): number {
      return dataBytes;
    },
  };
};

/**
 * Decodes the first audio stream of `path` to mono 48 kHz PCM with the
 * repository ffmpeg and reports how many seconds came out. Any non-zero exit, a
 * spawn failure, too much output or `timeoutMs` without an exit is a failure.
 */
export const decodeAudioFileWithFfmpeg = (
  path: string,
  deps: AudioPreflightDeps = {},
): Promise<FfmpegDecodeResult> =>
  new Promise((resolve) => {
    const binaries = deps.ffmpeg ?? resolveFfmpegBinaries();
    const spawnProcess = deps.spawn ?? (nodeSpawn as unknown as PreflightSpawn);
    const timeoutMs = deps.timeoutMs ?? AUDIO_PREFLIGHT_TIMEOUT_MS;
    const killGraceMs = deps.killGraceMs ?? AUDIO_PREFLIGHT_KILL_GRACE_MS;
    const counter = createWavDataCounter();
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let pending: FfmpegDecodeResult | null = null;
    let child: PreflightChild | null = null;

    const finish = (result: FfmpegDecodeResult) => {
      if (settled) {
        return;
      }

      settled = true;

      if (timer !== null) {
        clearTimeout(timer);
      }

      if (graceTimer !== null) {
        clearTimeout(graceTimer);
      }

      resolve(result);
    };
    const kill = () => {
      try {
        child?.kill();
      } catch {
        // The process already exited.
      }
    };

    // A failure decided while the child is still running (timeout, output bound):
    // kill it and report the failure when it has closed, or after the grace.
    const stop = (result: FfmpegDecodeResult) => {
      if (settled || pending !== null) {
        return;
      }

      pending = result;

      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }

      graceTimer = setTimeout(() => finish(result), killGraceMs);
      kill();
    };

    try {
      child = spawnProcess(
        binaries.ffmpeg,
        [
          "-v",
          "error",
          "-nostdin",
          "-i",
          `file:${path}`,
          "-map",
          "0:a:0",
          "-ac",
          "1",
          "-ar",
          String(PREFLIGHT_SAMPLE_RATE),
          "-t",
          String(PREFLIGHT_MAX_SECONDS),
          "-c:a",
          "pcm_s16le",
          "-f",
          "wav",
          "-",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: {
            ...process.env,
            LD_LIBRARY_PATH: [binaries.dir, process.env.LD_LIBRARY_PATH]
              .filter(Boolean)
              .join(":"),
            DYLD_LIBRARY_PATH: [binaries.dir, process.env.DYLD_LIBRARY_PATH]
              .filter(Boolean)
              .join(":"),
          },
        },
      );
    } catch (error) {
      finish({
        ok: false,
        reason: "spawn",
        detail: error instanceof Error ? error.message : String(error),
      });

      return;
    }

    deps.control?.attach(child);

    timer = setTimeout(() => {
      stop({
        ok: false,
        reason: "timeout",
        detail: `ffmpeg did not finish within ${timeoutMs / 1000} s`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      if (settled || pending !== null) {
        return;
      }

      try {
        counter.push(chunk);

        if (counter.dataBytes > PREFLIGHT_MAX_DECODED_BYTES) {
          stop({
            ok: false,
            reason: "output",
            detail: `ffmpeg decoded more than ${PREFLIGHT_MAX_SECONDS} s of audio`,
          });
        }
      } catch (error) {
        stop({
          ok: false,
          reason: "output",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR_CHARS) {
        stderr += Buffer.from(chunk).toString("utf8");
      }
    });
    child.on("error", (error) => {
      finish(pending ?? {ok: false, reason: "spawn", detail: error.message});
    });
    child.on("close", (code, signal) => {
      if (pending !== null) {
        finish(pending);

        return;
      }

      if (code !== 0) {
        const how =
          signal === null
            ? `exited with code ${code ?? "unknown"}`
            : `was stopped by ${signal}`;
        const why = stderr.trim() === "" ? "" : `: ${stderr.trim().slice(0, MAX_STDERR_CHARS)}`;

        finish({ok: false, reason: "exit", detail: `ffmpeg ${how}${why}`});

        return;
      }

      finish({
        ok: true,
        decodedSeconds: counter.dataBytes / PREFLIGHT_BYTES_PER_SECOND,
      });
    });
  });

/**
 * The preflight of one staged file: it decodes completely (D-9) or the
 * detail says why not. `durationSeconds` is the `inspectAudio` value that the
 * timeline uses for this file (AINV-3).
 */
export const checkAudioFileDecodes = async (
  path: string,
  durationSeconds: number,
  deps: AudioPreflightDeps = {},
): Promise<AudioDecodeCheck> => {
  const decoded = await decodeAudioFileWithFfmpeg(path, deps);

  if (!decoded.ok) {
    return {ok: false, detail: decoded.detail};
  }

  if (!isDecodeComplete(decoded.decodedSeconds, durationSeconds)) {
    return {
      ok: false,
      detail: `only ${decoded.decodedSeconds.toFixed(2)} s of ${durationSeconds.toFixed(2)} s could be decoded`,
    };
  }

  return {ok: true, decodedSeconds: decoded.decodedSeconds};
};
