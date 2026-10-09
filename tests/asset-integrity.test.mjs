import assert from "node:assert/strict";
import {test} from "node:test";
import {sha256Hex} from "../src/localAssets/hash.ts";
import {buildLocalAssetRef} from "../src/localAssets/refs.ts";
import {
  IntegrityCache,
  verifyPayload,
  verifyPayloadsSequentially,
} from "../src/web/assetLibrary/integrity.ts";
import {
  decodeAssetRow,
  decodePayloadMeta,
} from "../src/web/assetLibrary/records.ts";
import {buildJpeg, buildPng} from "./helpers/imageBytes.mjs";
import {createMemoryAssetStore} from "./helpers/memoryAssetStore.mjs";

const MIB = 1024 * 1024;

const pngBytes = (width = 4, height = 3) => buildPng({width, height});

/** Puts a payload into the fake with correct metadata. Returns its digest. */
const putPayload = async (store, bytes, overrides = {}) => {
  const digest = overrides.digest ?? (await sha256Hex(bytes));
  const meta = {
    mimeType: "image/png",
    byteSize: bytes.length,
    width: 4,
    height: 3,
    ...overrides.meta,
  };

  store.setRaw("payloadMeta", digest, meta);
  store.setRaw("blobs", digest, {
    blob: overrides.blob ?? new Blob([bytes], {type: meta.mimeType}),
  });

  return {digest, meta};
};

/**
 * A real Blob (so decodeBlobRecord's instanceof check passes) whose size is
 * faked and whose arrayBuffer is a counted stub. No large allocation happens.
 */
const fakeBlob = ({size, bytes, onArrayBuffer}) => {
  const blob = new Blob([bytes]);
  const state = {calls: 0};

  Object.defineProperty(blob, "size", {value: size});
  blob.arrayBuffer = async () => {
    state.calls += 1;

    if (onArrayBuffer !== undefined) {
      await onArrayBuffer();
    }

    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
  };

  return {blob, state};
};

test("a valid payload verifies and returns metadata equal to payloadMeta", async () => {
  const store = createMemoryAssetStore();
  const bytes = pngBytes(4, 3);
  const {digest, meta} = await putPayload(store, bytes);

  const result = await verifyPayload(store, digest);

  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, {digest, ...meta});
  assert.ok(result.blob instanceof Blob);
  assert.equal(result.blob.size, bytes.length);
});

test("verifyPayload accepts an injected SubtleCrypto", async () => {
  const store = createMemoryAssetStore();
  const {digest} = await putPayload(store, pngBytes());
  const calls = [];
  const subtle = {
    digest: (algorithm, data) => {
      calls.push(algorithm);

      return globalThis.crypto.subtle.digest(algorithm, data);
    },
  };

  const result = await verifyPayload(store, digest, {subtle});

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["SHA-256"]);
});

test("a JPEG payload verifies with its own mime type and size", async () => {
  const store = createMemoryAssetStore();
  const bytes = buildJpeg({width: 10, height: 20});
  const {digest} = await putPayload(store, bytes, {
    meta: {mimeType: "image/jpeg", width: 10, height: 20},
  });

  const result = await verifyPayload(store, digest);

  assert.equal(result.ok, true);
  assert.equal(result.payload.mimeType, "image/jpeg");
});

test("missing payloadMeta is missing and the blob is not read", async () => {
  const store = createMemoryAssetStore();
  const bytes = pngBytes();
  const digest = await sha256Hex(bytes);

  store.setRaw("blobs", digest, {blob: new Blob([bytes])});

  const result = await verifyPayload(store, digest);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing");
  assert.equal(store.reads.blobs, 0);
});

test("missing blob is missing", async () => {
  const store = createMemoryAssetStore();
  const bytes = pngBytes();
  const digest = await sha256Hex(bytes);

  store.setRaw("payloadMeta", digest, {
    mimeType: "image/png",
    byteSize: bytes.length,
    width: 4,
    height: 3,
  });

  const result = await verifyPayload(store, digest);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing");
});

test("corrupt payloadMeta or a corrupt blob record is corrupt", async () => {
  const store = createMemoryAssetStore();
  const bytes = pngBytes();
  const digest = await sha256Hex(bytes);

  store.setRaw("payloadMeta", digest, {mimeType: "image/gif"});
  store.setRaw("blobs", digest, {blob: new Blob([bytes])});

  const badMeta = await verifyPayload(store, digest);

  assert.equal(badMeta.ok, false);
  assert.equal(badMeta.reason, "corrupt");

  store.setRaw("payloadMeta", digest, {
    mimeType: "image/png",
    byteSize: bytes.length,
    width: 4,
    height: 3,
  });
  store.setRaw("blobs", digest, {blob: "not a blob"});

  const badBlob = await verifyPayload(store, digest);

  assert.equal(badBlob.ok, false);
  assert.equal(badBlob.reason, "corrupt");
});

test("a blob under digest A holding valid image-B bytes is corrupt (hash mismatch)", async () => {
  const store = createMemoryAssetStore();
  const bytesA = pngBytes(4, 3);
  const bytesB = pngBytes(5, 6);
  const digestA = await sha256Hex(bytesA);

  // Metadata is internally consistent with B's bytes; only the digest lies.
  await putPayload(store, bytesB, {
    digest: digestA,
    meta: {width: 5, height: 6},
  });

  const result = await verifyPayload(store, digestA);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "corrupt");
  assert.match(result.detail, /sha-?256|digest|hash/i);
});

test("correct bytes with falsified payloadMeta fields are corrupt", async () => {
  const bytes = pngBytes(4, 3);
  const falsifications = [
    {width: 5},
    {height: 4},
    {mimeType: "image/jpeg"},
    {byteSize: bytes.length + 1},
  ];

  for (const falsified of falsifications) {
    const store = createMemoryAssetStore();
    const {digest} = await putPayload(store, bytes, {meta: falsified});
    const result = await verifyPayload(store, digest);

    assert.equal(result.ok, false, JSON.stringify(falsified));
    assert.equal(result.reason, "corrupt", JSON.stringify(falsified));
  }
});

test("bytes that are not an image are corrupt even with a matching hash", async () => {
  const store = createMemoryAssetStore();
  const bytes = new TextEncoder().encode("hello, definitely not an image");
  const {digest} = await putPayload(store, bytes);

  const result = await verifyPayload(store, digest);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "corrupt");
});

test("a record claiming 250 MiB is corrupt and its bytes are never read", async () => {
  const store = createMemoryAssetStore();
  const digest = "a".repeat(64);
  const {blob, state} = fakeBlob({
    size: 250 * MIB,
    bytes: pngBytes(),
  });

  store.setRaw("payloadMeta", digest, {
    mimeType: "image/png",
    byteSize: 250 * MIB,
    width: 4,
    height: 3,
  });
  store.setRaw("blobs", digest, {blob});

  assert.equal(
    decodePayloadMeta(digest, store.getRaw("payloadMeta", digest)).status,
    "corrupt",
  );

  const result = await verifyPayload(store, digest);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "corrupt");
  assert.equal(state.calls, 0);
});

test("a blob larger than the limit is rejected from size alone, before any read", async () => {
  const store = createMemoryAssetStore();
  const bytes = pngBytes();
  const digest = await sha256Hex(bytes);
  const {blob, state} = fakeBlob({size: 250 * MIB, bytes});

  // payloadMeta looks sane, but the stored blob is huge.
  store.setRaw("payloadMeta", digest, {
    mimeType: "image/png",
    byteSize: bytes.length,
    width: 4,
    height: 3,
  });
  store.setRaw("blobs", digest, {blob});

  const result = await verifyPayload(store, digest);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "corrupt");
  assert.equal(state.calls, 0);
});

test("blob.size differing from payloadMeta.byteSize is rejected before any read", async () => {
  const store = createMemoryAssetStore();
  const bytes = pngBytes();
  const digest = await sha256Hex(bytes);
  const {blob, state} = fakeBlob({size: bytes.length + 10, bytes});

  store.setRaw("payloadMeta", digest, {
    mimeType: "image/png",
    byteSize: bytes.length,
    width: 4,
    height: 3,
  });
  store.setRaw("blobs", digest, {blob});

  const result = await verifyPayload(store, digest);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "corrupt");
  assert.equal(state.calls, 0);
});

test("payloadMeta with 9000x9000 or 8000x8000 dimensions decodes as corrupt", async () => {
  const digest = "b".repeat(64);

  for (const [width, height] of [
    [9000, 9000],
    [8000, 8000],
  ]) {
    const meta = {mimeType: "image/png", byteSize: 1000, width, height};

    assert.equal(decodePayloadMeta(digest, meta).status, "corrupt");

    const store = createMemoryAssetStore();

    store.setRaw("payloadMeta", digest, meta);
    store.setRaw("blobs", digest, {blob: new Blob([pngBytes()])});

    const result = await verifyPayload(store, digest);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "corrupt");
    assert.equal(store.reads.blobs, 0);
  }
});

test("an asset row claiming digest B under key A is corrupt and B is never read", async () => {
  const store = createMemoryAssetStore();
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  const refA = buildLocalAssetRef("pose", digestA);
  const row = {
    label: "x",
    originalFilename: "x.png",
    createdAt: "2026-10-09T00:00:00.000Z",
    digest: digestB,
  };

  assert.equal(decodeAssetRow(refA, row).status, "corrupt");

  store.setRaw("assets", refA, row);
  store.setRaw("payloadMeta", digestB, {
    mimeType: "image/png",
    byteSize: 10,
    width: 1,
    height: 1,
  });
  store.setRaw("blobs", digestB, {blob: new Blob([pngBytes(1, 1)])});
  store.resetReads();

  const decoded = await store.getAssetRow(refA);

  assert.equal(decoded.status, "corrupt");
  assert.equal(store.reads.payloadMeta, 0);
  assert.equal(store.reads.blobs, 0);
  assert.equal(store.reads.thumbnails, 0);
});

test("sequential verification keeps at most one payload read in flight (11 x 23 MiB)", async () => {
  const store = createMemoryAssetStore();
  const digests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let started = 0;

  for (let i = 0; i < 11; i += 1) {
    const bytes = pngBytes(10 + i, 3);
    const digest = await sha256Hex(bytes);
    const {blob} = fakeBlob({
      size: 23 * MIB,
      bytes,
      onArrayBuffer: async () => {
        started += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Yield a few macrotasks so overlapping reads would be observable.
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
      },
    });

    store.setRaw("payloadMeta", digest, {
      mimeType: "image/png",
      byteSize: 23 * MIB,
      width: 10 + i,
      height: 3,
    });
    store.setRaw("blobs", digest, {blob});
    digests.push(digest);
  }

  const results = await verifyPayloadsSequentially(
    store,
    digests,
    new IntegrityCache(),
  );

  assert.equal(started, 11);
  assert.equal(maxInFlight, 1);
  assert.equal(results.size, 11);

  for (const digest of digests) {
    assert.equal(results.get(digest)?.ok, true);
  }
});

test("aborting while digest 2 of 5 is verified throws AbortError and never reads 3-5", async () => {
  const store = createMemoryAssetStore();
  const controller = new AbortController();
  const digests = [];
  const readOrder = [];
  const cache = new IntegrityCache();

  for (let i = 0; i < 5; i += 1) {
    const bytes = pngBytes(10 + i, 3);
    const digest = await sha256Hex(bytes);
    const {blob} = fakeBlob({
      size: bytes.length,
      bytes,
      onArrayBuffer: async () => {
        readOrder.push(i);

        if (i === 1) {
          controller.abort();
        }

        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });

    store.setRaw("payloadMeta", digest, {
      mimeType: "image/png",
      byteSize: bytes.length,
      width: 10 + i,
      height: 3,
    });
    store.setRaw("blobs", digest, {blob});
    digests.push(digest);
  }

  await assert.rejects(
    () =>
      verifyPayloadsSequentially(store, digests, cache, {
        signal: controller.signal,
      }),
    (error) => error?.name === "AbortError",
  );

  assert.deepEqual(readOrder, [0, 1]);
  assert.equal(store.reads.blobs, 2);
});

test("an already-aborted signal reads nothing", async () => {
  const store = createMemoryAssetStore();
  const {digest} = await putPayload(store, pngBytes());
  const controller = new AbortController();

  controller.abort();
  store.resetReads();

  await assert.rejects(
    () =>
      verifyPayloadsSequentially(store, [digest], new IntegrityCache(), {
        signal: controller.signal,
      }),
    (error) => error?.name === "AbortError",
  );

  assert.equal(store.reads.payloadMeta, 0);
  assert.equal(store.reads.blobs, 0);
});

test("a cache hit avoids a second blob read and still returns the blob handle", async () => {
  const store = createMemoryAssetStore();
  const {digest, meta} = await putPayload(store, pngBytes());
  const cache = new IntegrityCache();

  const first = await verifyPayloadsSequentially(store, [digest], cache);

  assert.equal(first.get(digest)?.ok, true);
  assert.equal(store.reads.blobs, 1);

  const second = await verifyPayloadsSequentially(store, [digest], cache);
  const hit = second.get(digest);

  assert.equal(hit?.ok, true);
  assert.deepEqual(hit.payload, {digest, ...meta});
  assert.ok(hit.blob instanceof Blob);
  assert.equal(store.reads.blobs, 1);
});

test("invalidate([digest]) forces a re-read", async () => {
  const store = createMemoryAssetStore();
  const {digest} = await putPayload(store, pngBytes());
  const cache = new IntegrityCache();

  await verifyPayloadsSequentially(store, [digest], cache);
  cache.invalidate([digest]);
  assert.equal(cache.get(digest), undefined);

  await verifyPayloadsSequentially(store, [digest], cache);

  assert.equal(store.reads.blobs, 2);
});

test("clear() drops every cached payload", async () => {
  const store = createMemoryAssetStore();
  const one = await putPayload(store, pngBytes(4, 3));
  const two = await putPayload(store, pngBytes(5, 3), {meta: {width: 5}});
  const cache = new IntegrityCache();

  await verifyPayloadsSequentially(store, [one.digest, two.digest], cache);
  assert.ok(cache.get(one.digest));
  assert.ok(cache.get(two.digest));

  cache.clear();

  assert.equal(cache.get(one.digest), undefined);
  assert.equal(cache.get(two.digest), undefined);
});

test("a cached digest whose payloadMeta was deleted is not served", async () => {
  const store = createMemoryAssetStore();
  const {digest} = await putPayload(store, pngBytes());
  const cache = new IntegrityCache();

  await verifyPayloadsSequentially(store, [digest], cache);
  store.deleteRaw("payloadMeta", digest);

  const result = (await verifyPayloadsSequentially(store, [digest], cache)).get(
    digest,
  );

  assert.equal(result?.ok, false);
  assert.equal(result.reason, "missing");
});

test("a cached digest whose payloadMeta changed is re-verified, not served stale", async () => {
  const store = createMemoryAssetStore();
  const {digest} = await putPayload(store, pngBytes());
  const cache = new IntegrityCache();

  await verifyPayloadsSequentially(store, [digest], cache);
  store.setRaw("payloadMeta", digest, {
    mimeType: "image/png",
    byteSize: pngBytes().length,
    width: 99,
    height: 3,
  });

  const result = (await verifyPayloadsSequentially(store, [digest], cache)).get(
    digest,
  );

  assert.equal(result?.ok, false);
  assert.equal(result.reason, "corrupt");
  assert.equal(cache.get(digest), undefined);
});

test("failed verifications are never cached", async () => {
  const store = createMemoryAssetStore();
  const bytesA = pngBytes(4, 3);
  const digestA = await sha256Hex(bytesA);
  const cache = new IntegrityCache();

  await putPayload(store, pngBytes(5, 6), {
    digest: digestA,
    meta: {width: 5, height: 6},
  });

  const result = (
    await verifyPayloadsSequentially(store, [digestA], cache)
  ).get(digestA);

  assert.equal(result?.ok, false);
  assert.equal(cache.get(digestA), undefined);

  // Repair the record; the next run verifies (and caches) it.
  await putPayload(store, bytesA);

  const repaired = (
    await verifyPayloadsSequentially(store, [digestA], cache)
  ).get(digestA);

  assert.equal(repaired?.ok, true);
  assert.ok(cache.get(digestA));
});

test("mixed outcomes are reported per digest and duplicates are verified once", async () => {
  const store = createMemoryAssetStore();
  const good = await putPayload(store, pngBytes());
  const missing = "c".repeat(64);
  const cache = new IntegrityCache();

  const results = await verifyPayloadsSequentially(
    store,
    [good.digest, missing, good.digest],
    cache,
  );

  assert.equal(results.size, 2);
  assert.equal(results.get(good.digest)?.ok, true);
  assert.equal(results.get(missing)?.ok, false);
  assert.equal(results.get(missing).reason, "missing");
  assert.equal(store.reads.blobs, 1);
});

test("the verified blob carries the inspected type even when the stored Blob type is wrong or empty", async () => {
  for (const storedType of ["", "text/html", "image/jpeg"]) {
    const store = createMemoryAssetStore();
    const bytes = pngBytes(4, 3);
    const {digest} = await putPayload(store, bytes, {
      blob: new Blob([bytes], {type: storedType}),
    });

    const result = await verifyPayload(store, digest);

    assert.equal(result.ok, true, storedType);
    assert.equal(result.blob.type, "image/png", storedType);
    assert.equal(result.blob.size, bytes.length);
    assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), bytes);
  }
});

test("the integrity cache stores and returns the re-typed blob", async () => {
  const store = createMemoryAssetStore();
  const bytes = pngBytes(4, 3);
  const {digest} = await putPayload(store, bytes, {
    blob: new Blob([bytes], {type: "text/html"}),
  });
  const cache = new IntegrityCache();

  const first = await verifyPayloadsSequentially(store, [digest], cache);

  assert.equal(first.get(digest).blob.type, "image/png");
  assert.equal(cache.get(digest).blob.type, "image/png");

  const second = await verifyPayloadsSequentially(store, [digest], cache);

  assert.equal(second.get(digest).ok, true);
  assert.equal(second.get(digest).blob.type, "image/png");
});

test("a blob whose bytes cannot be read is corrupt and its digest is not cached", async () => {
  const store = createMemoryAssetStore();
  const bytes = pngBytes(4, 3);
  const {digest} = await putPayload(store, bytes);
  const blob = new Blob([bytes], {type: "image/png"});

  blob.arrayBuffer = async () => {
    throw new DOMException("The blob could not be read.", "NotReadableError");
  };
  store.setRaw("blobs", digest, {blob});

  const cache = new IntegrityCache();
  const results = await verifyPayloadsSequentially(store, [digest], cache);
  const result = results.get(digest);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "corrupt");
  assert.match(result.detail, /could not be read/);
  assert.equal(cache.get(digest), undefined);
});
