import {
  audioMimeTypeFor,
  inspectAudio,
} from "../../localAssets/audioInspection.ts";
import {sha256Hex} from "../../localAssets/hash.ts";
import {inspectImageBytes} from "../../localAssets/imageInspection.ts";
import {
  isAudioPayload,
  maxPayloadBytes,
  payloadKindOf,
  type AudioPayloadMetadata,
  type ImagePayloadMetadata,
  type PayloadMetadata,
} from "../../localAssets/readiness.ts";
import type {AssetLibraryStore} from "./store.ts";

export type VerifiedPayload =
  | ({digest: string} & ImagePayloadMetadata)
  | ({digest: string} & AudioPayloadMetadata);

export type PayloadVerification =
  | {ok: true; payload: VerifiedPayload; blob: Blob}
  | {ok: false; reason: "missing" | "corrupt"; detail: string};

const missing = (detail: string): PayloadVerification => ({
  ok: false,
  reason: "missing",
  detail,
});

const corrupt = (detail: string): PayloadVerification => ({
  ok: false,
  reason: "corrupt",
  detail,
});

/** The metadata duration may differ from `inspectAudio` of the bytes by at most this much. */
const AUDIO_DURATION_TOLERANCE_SECONDS = 0.001;

/** Never decodes: compares the container metadata of the bytes with the stored record. */
const checkAudioBytes = async (
  bytes: Uint8Array,
  meta: AudioPayloadMetadata,
): Promise<string | null> => {
  const inspected = await inspectAudio(bytes);

  if (!inspected.ok) {
    return `stored bytes are not a supported audio file (${inspected.message})`;
  }

  const {metadata} = inspected;

  if (
    metadata.container !== meta.container ||
    metadata.codec !== meta.codec ||
    audioMimeTypeFor(metadata.container) !== meta.mimeType
  ) {
    return "stored bytes do not match the recorded format";
  }

  if (metadata.sampleRate !== meta.sampleRate || metadata.channels !== meta.channels) {
    return "stored bytes do not match the recorded sample rate or channels";
  }

  if (
    Math.abs(metadata.durationSeconds - meta.durationSeconds) >
    AUDIO_DURATION_TOLERANCE_SECONDS
  ) {
    return "stored bytes do not match the recorded duration";
  }

  return null;
};

/**
 * Reads and checks the bytes. Kept in its own function so the `bytes` buffer
 * is unreachable as soon as it returns (at most one payload in memory).
 * Returns a failure detail, or null when the bytes match.
 */
const checkBytes = async (
  blob: Blob,
  digest: string,
  meta: PayloadMetadata,
  subtle: SubtleCrypto | undefined,
): Promise<string | null> => {
  let bytes: Uint8Array;

  try {
    bytes = new Uint8Array(await blob.arrayBuffer());
  } catch {
    return "stored bytes could not be read";
  }

  if ((await sha256Hex(bytes, subtle)) !== digest) {
    return "stored bytes do not match their SHA-256 digest";
  }

  if (isAudioPayload(meta)) {
    return checkAudioBytes(bytes, meta);
  }

  const inspected = inspectImageBytes(bytes);

  if (!inspected.ok) {
    return `stored bytes are not a supported image (${inspected.reason})`;
  }

  const {image} = inspected;

  if (image.mimeType !== meta.mimeType) {
    return "stored bytes do not match the recorded format";
  }

  if (image.width !== meta.width || image.height !== meta.height) {
    return "stored bytes do not match the recorded dimensions";
  }

  return null;
};

/**
 * INV-12: verifies the stored bytes for `digest` against the digest itself and
 * against the stored metadata (size, format, dimensions) before they are used.
 */
export const verifyPayload = async (
  store: AssetLibraryStore,
  digest: string,
  deps: {subtle?: SubtleCrypto} = {},
): Promise<PayloadVerification> => {
  const metaRecord = await store.getPayloadMeta(digest);

  if (metaRecord.status === "absent") {
    return missing("payload metadata is missing");
  }

  if (metaRecord.status === "corrupt") {
    return corrupt(`payload metadata is corrupt: ${metaRecord.reason}`);
  }

  const blobRecord = await store.getBlob(digest);

  if (blobRecord.status === "absent") {
    return missing("stored bytes are missing");
  }

  if (blobRecord.status === "corrupt") {
    return corrupt(`stored bytes are corrupt: ${blobRecord.reason}`);
  }

  const meta = metaRecord.value;
  const blob = blobRecord.value;

  // Decided from `blob.size` alone: nothing is read for an oversized record.
  if (blob.size !== meta.byteSize || blob.size > maxPayloadBytes(payloadKindOf(meta))) {
    return corrupt("stored size does not match the recorded size");
  }

  const problem = await checkBytes(blob, digest, meta, deps.subtle);

  if (problem !== null) {
    return corrupt(problem);
  }

  return {
    ok: true,
    payload: {digest, ...meta},
    // The stored Blob.type is untrusted; the bytes were just checked against meta.
    blob: blob.slice(0, blob.size, meta.mimeType),
  };
};

/**
 * The comparison between a verified payload and the current stored metadata,
 * used for cache hits and again after the shared lock (render preparation).
 * Different kinds are never the same; audio fields are compared exactly (both
 * sides are stored values, so any difference is a change; the 1 ms tolerance
 * only applies when `inspectAudio` of the bytes is compared with the record).
 */
export const samePayload = (
  verified: VerifiedPayload,
  current: PayloadMetadata,
): boolean => {
  if (isAudioPayload(verified)) {
    return (
      isAudioPayload(current) &&
      verified.mimeType === current.mimeType &&
      verified.byteSize === current.byteSize &&
      verified.container === current.container &&
      verified.codec === current.codec &&
      verified.sampleRate === current.sampleRate &&
      verified.channels === current.channels &&
      verified.durationSeconds === current.durationSeconds
    );
  }

  return (
    !isAudioPayload(current) &&
    verified.mimeType === current.mimeType &&
    verified.byteSize === current.byteSize &&
    verified.width === current.width &&
    verified.height === current.height
  );
};

/** A verification that is queued or running, shared by every caller of a digest. */
type InFlight = {
  promise: Promise<PayloadVerification>;
  waiters: number;
  started: boolean;
  cancelled: boolean;
};

/**
 * Per-page-session cache of verified payloads. In memory only. The Blob is a
 * handle onto the stored bytes (it does not copy them), kept so that a cache
 * hit can still produce a runtime source.
 *
 * Verification also lives here (D-8, ASSET-004 R14): `verify` shares one
 * in-flight verification per digest between callers and runs verifications one
 * at a time page-wide, so overlapping Story generations never hold two payloads.
 */
export class IntegrityCache {
  private readonly entries = new Map<
    string,
    {payload: VerifiedPayload; blob: Blob}
  >();
  // Dropped by `invalidate`/`clear`, so an entry that is no longer here is stale:
  // its result is not cached and later callers start a fresh verification.
  private readonly inFlight = new Map<string, InFlight>();
  private queueTail: Promise<void> = Promise.resolve();

  get(digest: string): {payload: VerifiedPayload; blob: Blob} | undefined {
    return this.entries.get(digest);
  }

  set(payload: VerifiedPayload, blob: Blob): void {
    this.entries.set(payload.digest, {payload, blob});
  }

  invalidate(digests: Iterable<string>): void {
    for (const digest of digests) {
      this.entries.delete(digest);
      this.inFlight.delete(digest);
    }
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  /**
   * Drops `stale` (a cached value whose metadata no longer agrees) if it is
   * still the cached value. Unlike `invalidate`, it leaves any in-flight
   * verification alone: another caller may already be re-verifying the digest.
   */
  evict(digest: string, stale: {payload: VerifiedPayload; blob: Blob}): void {
    if (this.entries.get(digest) === stale) {
      this.entries.delete(digest);
    }
  }

  /**
   * Verifies `digest`, joining a verification already queued or running for it.
   * Aborting `signal` only stops this caller from waiting: the shared
   * verification keeps going for the others (and is skipped when it has not
   * started and nobody waits for it any more). Never caches a failure.
   */
  async verify(
    store: AssetLibraryStore,
    digest: string,
    deps: {subtle?: SubtleCrypto; signal?: AbortSignal} = {},
  ): Promise<PayloadVerification> {
    const {signal} = deps;

    signal?.throwIfAborted();

    let entry = this.inFlight.get(digest);

    if (entry === undefined) {
      entry = this.startVerification(store, digest, deps.subtle);
    }

    const joined = entry;

    joined.waiters += 1;

    let left = false;
    // Synchronous, so the abort handler runs it before the queued task (a
    // microtask) can start: a read nobody waits for any more is never begun.
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
      return await new Promise<PayloadVerification>((resolve, reject) => {
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

  private startVerification(
    store: AssetLibraryStore,
    digest: string,
    subtle: SubtleCrypto | undefined,
  ): InFlight {
    const entry: InFlight = {
      promise: undefined as unknown as Promise<PayloadVerification>,
      waiters: 0,
      started: false,
      cancelled: false,
    };
    const task = async (): Promise<PayloadVerification> => {
      if (entry.cancelled) {
        return missing("verification was cancelled");
      }

      entry.started = true;

      try {
        const result = await verifyPayload(store, digest, {subtle});

        // Invalidation wins: a stale verification is returned to the callers
        // that joined it but never cached.
        if (result.ok && this.inFlight.get(digest) === entry) {
          this.set(result.payload, result.blob);
        }

        return result;
      } finally {
        if (this.inFlight.get(digest) === entry) {
          this.inFlight.delete(digest);
        }
      }
    };

    // One verification at a time, page-wide.
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

/**
 * Verifies digests strictly one after another; `cache.verify` shares and
 * serializes the reads page-wide (MAX one payload in memory, D-8).
 */
export const verifyPayloadsSequentially = async (
  store: AssetLibraryStore,
  digests: readonly string[],
  cache: IntegrityCache,
  deps: {subtle?: SubtleCrypto; signal?: AbortSignal} = {},
): Promise<Map<string, PayloadVerification>> => {
  const results = new Map<string, PayloadVerification>();

  for (const digest of digests) {
    // Cancellation stops before the next payload is read.
    deps.signal?.throwIfAborted();

    if (results.has(digest)) {
      continue;
    }

    const cached = cache.get(digest);

    if (cached !== undefined) {
      // A hit skips the blob read, but the metadata must still exist and
      // agree: a deleted or changed record is never served from cache.
      const metaRecord = await store.getPayloadMeta(digest);

      if (
        metaRecord.status === "present" &&
        samePayload(cached.payload, metaRecord.value)
      ) {
        results.set(digest, {ok: true, payload: cached.payload, blob: cached.blob});
        continue;
      }

      cache.evict(digest, cached);

      if (metaRecord.status === "absent") {
        results.set(digest, missing("payload metadata is missing"));
        continue;
      }

      // Another caller may have re-verified the digest while this metadata
      // check was pending: serve that newer entry if it agrees.
      const fresh = cache.get(digest);

      if (
        fresh !== undefined &&
        metaRecord.status === "present" &&
        samePayload(fresh.payload, metaRecord.value)
      ) {
        results.set(digest, {ok: true, payload: fresh.payload, blob: fresh.blob});
        continue;
      }
    }

    results.set(digest, await cache.verify(store, digest, deps));
  }

  return results;
};
