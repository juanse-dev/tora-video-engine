import {sha256Hex} from "../../localAssets/hash.ts";
import {inspectImageBytes} from "../../localAssets/imageInspection.ts";
import {MAX_LOCAL_ASSET_BYTES} from "../../localAssets/limits.ts";
import type {PayloadMetadata} from "../../localAssets/readiness.ts";
import type {AssetLibraryStore} from "./store.ts";

export type VerifiedPayload = {digest: string} & PayloadMetadata;

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
  if (blob.size !== meta.byteSize || blob.size > MAX_LOCAL_ASSET_BYTES) {
    return corrupt("stored size does not match the recorded size");
  }

  const problem = await checkBytes(blob, digest, meta, deps.subtle);

  if (problem !== null) {
    return corrupt(problem);
  }

  return {
    ok: true,
    payload: {
      digest,
      mimeType: meta.mimeType,
      byteSize: meta.byteSize,
      width: meta.width,
      height: meta.height,
    },
    // The stored Blob.type is untrusted; the bytes were just checked against meta.
    blob: blob.slice(0, blob.size, meta.mimeType),
  };
};

const samePayload = (a: VerifiedPayload, b: PayloadMetadata): boolean =>
  a.mimeType === b.mimeType &&
  a.byteSize === b.byteSize &&
  a.width === b.width &&
  a.height === b.height;

/**
 * Per-page-session cache of verified payloads. In memory only. The Blob is a
 * handle onto the stored bytes (it does not copy them), kept so that a cache
 * hit can still produce a runtime source.
 */
export class IntegrityCache {
  private readonly entries = new Map<
    string,
    {payload: VerifiedPayload; blob: Blob}
  >();

  get(digest: string): {payload: VerifiedPayload; blob: Blob} | undefined {
    return this.entries.get(digest);
  }

  set(payload: VerifiedPayload, blob: Blob): void {
    this.entries.set(payload.digest, {payload, blob});
  }

  invalidate(digests: Iterable<string>): void {
    for (const digest of digests) {
      this.entries.delete(digest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Verifies digests strictly one after another (MAX one payload in memory). */
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

      cache.invalidate([digest]);

      if (metaRecord.status === "absent") {
        results.set(digest, missing("payload metadata is missing"));
        continue;
      }
    }

    const result = await verifyPayload(store, digest, {subtle: deps.subtle});

    if (result.ok) {
      cache.set(result.payload, result.blob);
    }

    results.set(digest, result);
  }

  return results;
};
