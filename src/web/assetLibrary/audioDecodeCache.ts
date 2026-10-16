import {isDecodeComplete} from "../../audio/decodeCheck.ts";
import type {AudioMetadata} from "../../localAssets/audioInspection.ts";
import {decodeAudioPeaks} from "./audioPeaks.ts";

/** The outcome of one session decode of a local audio payload (AINV-8). */
export type AudioDecodeCheck = {ok: true} | {ok: false; detail: string};

/** `decodeAudioPeaks` reduced to what the check needs; tests inject a fake. */
export type DecodeAudio = (
  blob: Blob,
  metadata: AudioMetadata,
  deps: {signal: AbortSignal},
) => Promise<{decodedSeconds: number}>;

/**
 * One decode runs at a time page-wide, so a decode that never settles would
 * block every later render: it fails after this long instead (a 300 s MP3
 * decodes in about a second).
 */
export const AUDIO_DECODE_TIMEOUT_MS = 30_000;

export type DecodeTimers = {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** A decode that is queued or running, shared by every caller of a digest. */
type InFlight = {
  promise: Promise<AudioDecodeCheck>;
  waiters: number;
  started: boolean;
  cancelled: boolean;
};

const secondsText = (seconds: number): string => seconds.toFixed(2);

/**
 * Per-page-session cache of full decodes of local audio payloads. The import
 * decode does not count: after a reload, bytes whose metadata still parses
 * could fail to decode, and only a decode proves the renderer will not stall
 * on them. A Story's first render therefore pays at most one decode per
 * distinct source (~1 s for a 300 s MP3), later renders none. A decode that
 * does not settle within `AUDIO_DECODE_TIMEOUT_MS` is aborted and is a failure.
 *
 * It follows the integrity cache's rules (ASSET-004 R14, D-8): one decode at a
 * time page-wide, one in-flight decode per digest shared by its callers, an
 * invalidation (a library change) wins over an in-flight result, and aborting
 * only stops one caller from waiting. A failure is never cached.
 */
export class AudioDecodeCache {
  private readonly passed = new Set<string>();
  // Dropped by `invalidate`/`clear`, so an entry that is no longer here is stale:
  // its result is not cached and later callers start a fresh decode.
  private readonly inFlight = new Map<string, InFlight>();
  private queueTail: Promise<void> = Promise.resolve();
  private readonly decode: DecodeAudio;
  private readonly timeoutMs: number;
  private readonly timers: DecodeTimers;

  constructor(
    decode: DecodeAudio = (blob, metadata, deps) =>
      decodeAudioPeaks(blob, metadata, deps),
    options: {timeoutMs?: number; timers?: DecodeTimers} = {},
  ) {
    this.decode = decode;
    this.timeoutMs = options.timeoutMs ?? AUDIO_DECODE_TIMEOUT_MS;
    this.timers = options.timers ?? {
      setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  /** One decode with its own abort signal and timeout. */
  private decodeWithTimeout(
    blob: Blob,
    metadata: AudioMetadata,
  ): Promise<{decodedSeconds: number}> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timer = this.timers.setTimeout(() => {
        controller.abort();
        reject(
          new Error(
            `the decode did not finish within ${this.timeoutMs / 1000} s`,
          ),
        );
      }, this.timeoutMs);

      this.decode(blob, metadata, {signal: controller.signal}).then(
        (result) => {
          this.timers.clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          this.timers.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** True when this digest decoded completely earlier in the session. */
  has(digest: string): boolean {
    return this.passed.has(digest);
  }

  invalidate(digests: Iterable<string>): void {
    for (const digest of digests) {
      this.passed.delete(digest);
      this.inFlight.delete(digest);
    }
  }

  clear(): void {
    this.passed.clear();
    this.inFlight.clear();
  }

  /**
   * Decodes `blob` completely (D-9), joining a decode already queued or
   * running for `digest`. Aborting `signal` only stops this caller from
   * waiting: the shared decode keeps going for the others, and is skipped when
   * it has not started and nobody waits for it any more.
   */
  async verify(
    digest: string,
    blob: Blob,
    metadata: AudioMetadata,
    deps: {signal?: AbortSignal} = {},
  ): Promise<AudioDecodeCheck> {
    const {signal} = deps;

    signal?.throwIfAborted();

    if (this.passed.has(digest)) {
      return {ok: true};
    }

    let entry = this.inFlight.get(digest);

    if (entry === undefined) {
      entry = this.startDecode(digest, blob, metadata);
    }

    const joined = entry;

    joined.waiters += 1;

    let left = false;
    // Synchronous, so the abort handler runs it before the queued task (a
    // microtask) can start: a decode nobody waits for any more is never begun.
    const leave = () => {
      if (left) {
        return;
      }

      left = true;
      joined.waiters -= 1;

      if (joined.waiters === 0 && !joined.started) {
        joined.cancelled = true;

        if (this.inFlight.get(digest) === joined) {
          this.inFlight.delete(digest);
        }
      }
    };

    if (signal === undefined) {
      try {
        return await joined.promise;
      } finally {
        leave();
      }
    }

    try {
      return await new Promise<AudioDecodeCheck>((resolve, reject) => {
        const onAbort = () => {
          leave();
          reject(signal.reason);
        };

        signal.addEventListener("abort", onAbort, {once: true});
        joined.promise.then(
          (result) => {
            signal.removeEventListener("abort", onAbort);
            resolve(result);
          },
          (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
    } finally {
      leave();
    }
  }

  private startDecode(
    digest: string,
    blob: Blob,
    metadata: AudioMetadata,
  ): InFlight {
    const entry: InFlight = {
      promise: undefined as unknown as Promise<AudioDecodeCheck>,
      waiters: 0,
      started: false,
      cancelled: false,
    };
    const task = async (): Promise<AudioDecodeCheck> => {
      if (entry.cancelled) {
        return {ok: false, detail: "the decode was cancelled"};
      }

      entry.started = true;

      try {
        let result: AudioDecodeCheck;

        try {
          const decoded = await this.decodeWithTimeout(blob, metadata);

          result = isDecodeComplete(decoded.decodedSeconds, metadata.durationSeconds)
            ? {ok: true}
            : {
                ok: false,
                detail: `only ${secondsText(decoded.decodedSeconds)} s of ${secondsText(metadata.durationSeconds)} s could be decoded`,
              };
        } catch (error) {
          result = {
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          };
        }

        // Invalidation wins: a stale decode is returned to the callers that
        // joined it but never cached.
        if (result.ok && this.inFlight.get(digest) === entry) {
          this.passed.add(digest);
        }

        return result;
      } finally {
        if (this.inFlight.get(digest) === entry) {
          this.inFlight.delete(digest);
        }
      }
    };

    // One decode at a time, page-wide.
    const run = this.queueTail.then(task);

    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    entry.promise = run;
    this.inFlight.set(digest, entry);

    return entry;
  }
}
