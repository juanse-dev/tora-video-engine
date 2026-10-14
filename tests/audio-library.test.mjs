import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  MAX_AUDIO_DURATION_SECONDS,
  MAX_LOCAL_ASSET_BYTES,
  MAX_LOCAL_AUDIO_BYTES,
} from "../src/localAssets/limits.ts";
import {payloadKindOf} from "../src/localAssets/readiness.ts";
import {buildLocalAssetRef} from "../src/localAssets/refs.ts";
import {MAX_WAVEFORM_PEAKS} from "../src/audio/constants.ts";
import {ASSET_DB_VERSION, LOCAL_ASSET_PAGE_SIZE} from "../src/web/assetLibrary/constants.ts";
import {
  countLocalAssets,
  deleteLocalAsset,
  listLocalAssetPage,
  readAudioDurations,
  readAudioMetadata,
  readWaveform,
  renameLocalAsset,
} from "../src/web/assetLibrary/library.ts";
import {deletionScope} from "../src/web/assetLibrary/payloadScope.ts";
import {
  decodeAssetRow,
  decodePayloadMeta,
  decodeWaveform,
  payloadMatchesCategory,
} from "../src/web/assetLibrary/records.ts";
import {createMemoryAssetStore, createMemoryLockManager} from "./helpers/memoryAssetStore.mjs";

const digestOf = (n) => n.toString(16).padStart(64, "0");
const DIGEST = digestOf(1);
const audioRef = (n) => buildLocalAssetRef("audio", digestOf(n));
const poseRef = (n) => buildLocalAssetRef("pose", digestOf(n));
const CREATED_AT = "2026-01-02T03:04:05.000Z";
const validRow = {label: "Voice", originalFilename: "voice.mp3", createdAt: CREATED_AT};
const imageMeta = {mimeType: "image/png", byteSize: 100, width: 10, height: 20};
const audioMeta = {
  kind: "audio",
  mimeType: "audio/mpeg",
  byteSize: 36_381,
  container: "mp3",
  codec: "mp3",
  durationSeconds: 2.2465,
  sampleRate: 44_100,
  channels: 2,
};
const MIB = 1024 * 1024;

describe("decodePayloadMeta: image records are unchanged", () => {
  it("returns the v0.3 shape without a kind field", () => {
    assert.deepEqual(decodePayloadMeta(DIGEST, imageMeta), {status: "present", value: imageMeta});
    assert.equal("kind" in decodePayloadMeta(DIGEST, imageMeta).value, false);
    assert.equal(payloadKindOf(decodePayloadMeta(DIGEST, imageMeta).value), "image");
  });

  it("tolerates a stored kind: image and drops it", () => {
    assert.deepEqual(decodePayloadMeta(DIGEST, {...imageMeta, kind: "image"}), {status: "present", value: imageMeta});
  });

  it("rejects an unknown kind", () => {
    for (const kind of ["Audio", "video", "", 3, null]) {
      assert.equal(decodePayloadMeta(DIGEST, {...imageMeta, kind}).status, "corrupt", String(kind));
    }
  });

  it("keeps the 25 MiB image ceiling: a 30 MiB image record is corrupt", () => {
    assert.equal(decodePayloadMeta(DIGEST, {...imageMeta, byteSize: MAX_LOCAL_ASSET_BYTES}).status, "present");
    assert.equal(decodePayloadMeta(DIGEST, {...imageMeta, byteSize: 30 * MIB}).status, "corrupt");
  });
});

describe("decodePayloadMeta: audio records", () => {
  it("decodes a valid record exactly", () => {
    assert.deepEqual(decodePayloadMeta(DIGEST, audioMeta), {status: "present", value: audioMeta});
    assert.equal(payloadKindOf(audioMeta), "audio");
  });

  it("accepts every accepted (container, codec, mime) triple", () => {
    for (const [container, codec, mimeType] of [
      ["mp3", "mp3", "audio/mpeg"], ["wave", "pcm", "audio/wav"], ["mp4", "aac", "audio/mp4"], ["ogg", "opus", "audio/ogg"],
    ]) {
      assert.equal(decodePayloadMeta(DIGEST, {...audioMeta, container, codec, mimeType}).status, "present", container);
    }
  });

  it("accepts a 30 MiB audio record and rejects 50 MiB + 1", () => {
    assert.equal(decodePayloadMeta(DIGEST, {...audioMeta, byteSize: 30 * MIB}).status, "present");
    assert.equal(decodePayloadMeta(DIGEST, {...audioMeta, byteSize: MAX_LOCAL_AUDIO_BYTES}).status, "present");
    assert.equal(decodePayloadMeta(DIGEST, {...audioMeta, byteSize: MAX_LOCAL_AUDIO_BYTES + 1}).status, "corrupt");
  });

  it("rejects out-of-range or mistyped fields", () => {
    const bad = [
      {mimeType: "audio/ogg"}, // not the container's MIME type
      {mimeType: "image/png"},
      {container: "flac"}, {container: 7},
      {codec: "vorbis"}, {codec: "aac"}, // not an accepted pair for mp3
      {byteSize: 0}, {byteSize: -1}, {byteSize: 1.5}, {byteSize: Number.NaN}, {byteSize: "36381"},
      {durationSeconds: 0}, {durationSeconds: -1}, {durationSeconds: Number.NaN}, {durationSeconds: Number.POSITIVE_INFINITY},
      {durationSeconds: MAX_AUDIO_DURATION_SECONDS + 0.001}, {durationSeconds: "2.2"},
      {sampleRate: 7_999}, {sampleRate: 96_001}, {sampleRate: 44_100.5}, {sampleRate: Number.NaN},
      {channels: 0}, {channels: 3}, {channels: 1.5}, {channels: -1}, {channels: Number.NaN},
    ];

    for (const patch of bad) {
      assert.equal(decodePayloadMeta(DIGEST, {...audioMeta, ...patch}).status, "corrupt", JSON.stringify(patch));
    }
  });

  it("is strict: any extra key, including identity fields, is corrupt", () => {
    for (const extra of [{width: 10}, {thumbnail: 1}, {digest: DIGEST}, {digest: digestOf(2)}, {ref: audioRef(1)}, {ref: audioRef(2)}, {category: "audio"}]) {
      assert.equal(decodePayloadMeta(DIGEST, {...audioMeta, ...extra}).status, "corrupt", JSON.stringify(extra));
    }

    const missing = {...audioMeta};

    delete missing.channels;
    assert.equal(decodePayloadMeta(DIGEST, missing).status, "corrupt");
  });

  it("maps undefined to absent and a bad key to corrupt", () => {
    assert.deepEqual(decodePayloadMeta(DIGEST, undefined), {status: "absent"});
    assert.equal(decodePayloadMeta("not-a-digest", audioMeta).status, "corrupt");
  });
});

describe("payloadMatchesCategory: an audio row must point at audio metadata and an image row at image metadata", () => {
  it("matches by kind", () => {
    assert.equal(payloadMatchesCategory(audioMeta, "audio"), true);
    assert.equal(payloadMatchesCategory(audioMeta, "pose"), false);
    assert.equal(payloadMatchesCategory(audioMeta, "background"), false);
    assert.equal(payloadMatchesCategory(imageMeta, "pose"), true);
    assert.equal(payloadMatchesCategory(imageMeta, "background"), true);
    assert.equal(payloadMatchesCategory(imageMeta, "audio"), false);
  });
});

describe("decodeWaveform", () => {
  const peaks = Uint8Array.from([0, 10, 255]);

  it("decodes exactly {peaksPerSecond, peaks}", () => {
    assert.deepEqual(decodeWaveform(DIGEST, {peaksPerSecond: 50, peaks}), {status: "present", value: {peaksPerSecond: 50, peaks}});
    assert.deepEqual(decodeWaveform(DIGEST, undefined), {status: "absent"});
  });

  it("rejects any extra key, including a digest of the right or the wrong value (the key is the only identity)", () => {
    for (const extra of [{digest: DIGEST}, {digest: digestOf(2)}, {ref: audioRef(1)}, {category: "audio"}, {other: 1}]) {
      assert.equal(decodeWaveform(DIGEST, {peaksPerSecond: 50, peaks, ...extra}).status, "corrupt", JSON.stringify(extra));
    }
  });

  it("rejects bad peaksPerSecond and bad peaks", () => {
    for (const peaksPerSecond of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "50", undefined]) {
      assert.equal(decodeWaveform(DIGEST, {peaksPerSecond, peaks}).status, "corrupt", String(peaksPerSecond));
    }

    for (const bad of [[], [1, 2, 3], new Uint8Array(0), new Uint16Array(3), new Float32Array(3), "abc", null, new Uint8Array(MAX_WAVEFORM_PEAKS + 1)]) {
      assert.equal(decodeWaveform(DIGEST, {peaksPerSecond: 50, peaks: bad}).status, "corrupt");
    }

    assert.equal(decodeWaveform(DIGEST, {peaksPerSecond: 50, peaks: new Uint8Array(MAX_WAVEFORM_PEAKS)}).status, "present");
    assert.equal(decodeWaveform(DIGEST, {peaks}).status, "corrupt");
    assert.equal(decodeWaveform(DIGEST, {peaksPerSecond: 50}).status, "corrupt");
    assert.equal(decodeWaveform(DIGEST, null).status, "corrupt");
    assert.equal(decodeWaveform("nope", {peaksPerSecond: 50, peaks}).status, "corrupt");
  });
});

describe("decodeAssetRow for audio keys (category-correct)", () => {
  it("decodes a canonical audio row and tolerates only identity fields equal to what the key implies", () => {
    assert.deepEqual(decodeAssetRow(audioRef(1), validRow), {status: "present", value: validRow});
    assert.deepEqual(decodeAssetRow(audioRef(1), {...validRow, ref: audioRef(1), category: "audio", digest: DIGEST}), {status: "present", value: validRow});

    for (const extra of [{category: "pose"}, {category: "background"}, {ref: poseRef(1)}, {ref: audioRef(2)}, {digest: digestOf(2)}]) {
      assert.equal(decodeAssetRow(audioRef(1), {...validRow, ...extra}).status, "corrupt", JSON.stringify(extra));
    }
  });
});

const backgroundRef = (n) => buildLocalAssetRef("background", digestOf(n));
const peaks = Uint8Array.from([1, 2, 3, 250]);
const audioMutation = (ref = audioRef(1), overrides = {}) => ({
  kind: "import-audio",
  ref,
  defaultLabel: "Voice",
  originalFilename: "voice.mp3",
  createdAt: CREATED_AT,
  payloadMeta: {...audioMeta},
  blob: new Blob([new Uint8Array([1, 2, 3])], {type: "audio/mpeg"}),
  waveform: {peaksPerSecond: 50, peaks},
  ...overrides,
});
const makeLibrary = (store = createMemoryAssetStore()) => {
  const posted = [];

  return {store, locks: createMemoryLockManager(), posted, channel: {post: (message) => posted.push(message)}};
};

describe("storage constants", () => {
  it("the database version is 2", () => {
    assert.equal(ASSET_DB_VERSION, 2);
  });
});

describe("deletionScope is category-correct", () => {
  it("audio has no other category and owns the waveform; an image's other category is the other image category", () => {
    assert.deepEqual(deletionScope("audio", DIGEST), {protectingRefs: [], derivedStores: ["waveforms"]});
    assert.deepEqual(deletionScope("pose", DIGEST), {protectingRefs: [backgroundRef(1)], derivedStores: ["thumbnails"]});
    assert.deepEqual(deletionScope("background", DIGEST), {protectingRefs: [poseRef(1)], derivedStores: ["thumbnails"]});
  });
});

describe("audio transactions (in-memory store)", () => {
  it("an audio import writes row, payloadMeta, blob and waveform in one apply and no thumbnail", async () => {
    const store = createMemoryAssetStore();
    const result = await store.apply(audioMutation());

    assert.deepEqual(result, {kind: "imported", ref: audioRef(1), created: true});
    assert.equal(store.applyCalls.length, 1);
    assert.deepEqual(store.getRaw("assets", audioRef(1)), {label: "Voice", originalFilename: "voice.mp3", createdAt: CREATED_AT});
    assert.deepEqual(store.getRaw("payloadMeta", DIGEST), audioMeta);
    assert.equal(store.hasRaw("blobs", DIGEST), true);
    assert.deepEqual(Object.keys(store.getRaw("waveforms", DIGEST)).sort(), ["peaks", "peaksPerSecond"]);
    assert.equal(store.stores.thumbnails.size, 0);
    assert.deepEqual((await store.getWaveform(DIGEST)).value.peaks, peaks);
    assert.equal((await store.getPayloadMeta(DIGEST)).value.kind, "audio");
  });

  it("re-importing keeps label and createdAt, refreshes the filename and repairs a missing waveform", async () => {
    const store = createMemoryAssetStore();

    await store.apply(audioMutation());
    await store.apply({kind: "rename", ref: audioRef(1), label: "Renamed"});
    store.deleteRaw("waveforms", DIGEST);

    const again = await store.apply(audioMutation(audioRef(1), {defaultLabel: "Fresh", originalFilename: "new.mp3", createdAt: "2030-01-01T00:00:00.000Z"}));

    assert.equal(again.created, false);
    assert.deepEqual(store.getRaw("assets", audioRef(1)), {label: "Renamed", originalFilename: "new.mp3", createdAt: CREATED_AT});
    assert.equal((await store.getWaveform(DIGEST)).status, "present");
  });

  it("an import kind that does not match its ref's category throws before writing anything", async () => {
    const store = createMemoryAssetStore();
    const before = store.snapshot();

    await assert.rejects(store.apply(audioMutation(poseRef(1))), /import-audio does not accept a pose ref/u);
    await assert.rejects(
      store.apply({kind: "import", ref: audioRef(1), defaultLabel: "x", originalFilename: "x", createdAt: CREATED_AT, payloadMeta: {mimeType: "image/png", byteSize: 1, width: 1, height: 1}, blob: new Blob([new Uint8Array([1])]), thumbnail: {blob: new Blob([new Uint8Array([1])]), mimeType: "image/png", width: 1, height: 1}}),
      /import does not accept a audio ref/u,
    );
    assert.deepEqual(store.snapshot(), before);
  });

  it("deleting the last audio ref removes payloadMeta, blob and waveform; other digests stay", async () => {
    const store = createMemoryAssetStore();

    await store.apply(audioMutation(audioRef(1)));
    await store.apply(audioMutation(audioRef(2), {payloadMeta: {...audioMeta, byteSize: 7}}));

    assert.deepEqual(await store.apply({kind: "delete", ref: audioRef(1)}), {kind: "deleted", ref: audioRef(1), payloadRemoved: true});
    assert.equal(store.hasRaw("payloadMeta", digestOf(1)), false);
    assert.equal(store.hasRaw("blobs", digestOf(1)), false);
    assert.equal(store.hasRaw("waveforms", digestOf(1)), false);
    assert.equal(store.hasRaw("waveforms", digestOf(2)), true);
    assert.deepEqual(await store.apply({kind: "delete", ref: audioRef(1)}), {kind: "not-found", ref: audioRef(1)});
  });

  it("an image delete never touches waveforms and an audio delete never touches thumbnails", async () => {
    const store = createMemoryAssetStore();
    const thumbnail = {blob: new Blob([new Uint8Array([1])]), mimeType: "image/png", width: 1, height: 1};

    store.setRaw("assets", poseRef(5), validRow);
    store.setRaw("payloadMeta", digestOf(5), imageMeta);
    store.setRaw("waveforms", digestOf(5), {peaksPerSecond: 50, peaks});
    await store.apply({kind: "delete", ref: poseRef(5)});
    assert.equal(store.hasRaw("waveforms", digestOf(5)), true);

    store.setRaw("assets", audioRef(6), validRow);
    store.setRaw("payloadMeta", digestOf(6), audioMeta);
    store.setRaw("thumbnails", digestOf(6), thumbnail);
    await store.apply({kind: "delete", ref: audioRef(6)});
    assert.equal(store.hasRaw("thumbnails", digestOf(6)), true);
  });

  it("the shared-digest rule still holds between the two image categories", async () => {
    const store = createMemoryAssetStore();

    store.setRaw("assets", poseRef(7), validRow);
    store.setRaw("assets", backgroundRef(7), validRow);
    store.setRaw("payloadMeta", digestOf(7), imageMeta);

    assert.equal((await store.apply({kind: "delete", ref: poseRef(7)})).payloadRemoved, false);
    assert.equal((await store.apply({kind: "delete", ref: backgroundRef(7)})).payloadRemoved, true);
  });

  it("a quota failure in an audio import leaves every store unchanged", async () => {
    const store = createMemoryAssetStore();

    await store.apply(audioMutation(audioRef(1)));

    const before = store.snapshot();

    store.failNextApply();
    await assert.rejects(store.apply(audioMutation(audioRef(2))));
    assert.deepEqual(store.snapshot(), before);
  });

  it("waveform identity is the key only: a value under key A carrying digest B is corrupt and never redirects to B", async () => {
    const store = createMemoryAssetStore();
    const other = Uint8Array.from([9, 9, 9]);

    store.setRaw("waveforms", digestOf(2), {peaksPerSecond: 50, peaks: other});
    store.setRaw("waveforms", digestOf(1), {peaksPerSecond: 50, peaks, digest: digestOf(2)});

    assert.equal((await store.getWaveform(digestOf(1))).status, "corrupt");
    assert.equal(await readWaveform(store, digestOf(1)), null);
    assert.deepEqual((await readWaveform(store, digestOf(2))).peaks, other);

    store.setRaw("waveforms", digestOf(1), {peaksPerSecond: 50, peaks, digest: digestOf(1)});
    assert.equal((await store.getWaveform(digestOf(1))).status, "corrupt");
  });

  it("lists and counts only the requested category and pages audio like images", async () => {
    const store = createMemoryAssetStore();

    for (let n = 1; n <= LOCAL_ASSET_PAGE_SIZE + 1; n += 1) {
      store.setRaw("assets", audioRef(n), {...validRow, label: `Audio ${n}`});
    }

    store.setRaw("assets", poseRef(1), validRow);
    store.setRaw("assets", backgroundRef(1), validRow);

    assert.equal(await store.countAssets("audio"), LOCAL_ASSET_PAGE_SIZE + 1);
    assert.equal(await store.countAssets("pose"), 1);

    const first = await listLocalAssetPage(store, "audio");

    assert.equal(first.entries.length, LOCAL_ASSET_PAGE_SIZE);
    assert.equal(first.hasNext, true);
    assert.equal(first.entries.every((entry) => entry.category === "audio"), true);
    assert.equal(first.entries.at(-1).ref, audioRef(LOCAL_ASSET_PAGE_SIZE));

    const second = await listLocalAssetPage(store, "audio", {after: first.entries.at(-1).ref});

    assert.deepEqual(second.entries.map((entry) => entry.ref), [audioRef(LOCAL_ASSET_PAGE_SIZE + 1)]);
    assert.equal(second.hasNext, false);
  });
});

describe("library audio reads", () => {
  const seedAudio = (store, n, patch = {}) => {
    store.setRaw("assets", audioRef(n), {...validRow, label: `Audio ${n}`});
    store.setRaw("payloadMeta", digestOf(n), {...audioMeta, ...patch});
  };

  it("readAudioMetadata returns the stored metadata of a present row only", async () => {
    const store = createMemoryAssetStore();

    seedAudio(store, 1);
    store.setRaw("payloadMeta", digestOf(2), audioMeta); // payload without a row
    store.setRaw("assets", audioRef(3), "corrupt row");
    store.setRaw("payloadMeta", digestOf(3), audioMeta);
    store.setRaw("assets", audioRef(4), validRow);
    store.setRaw("payloadMeta", digestOf(4), imageMeta); // an audio row pointing at image metadata
    store.setRaw("assets", audioRef(5), validRow); // no metadata

    assert.deepEqual(await readAudioMetadata(store, audioRef(1)), audioMeta);

    for (const n of [2, 3, 4, 5, 6]) {
      assert.equal(await readAudioMetadata(store, audioRef(n)), null, String(n));
    }
  });

  it("readAudioDurations finds a ref that is not on the first library page and omits an absent one, without listing", async () => {
    const store = createMemoryAssetStore();

    for (let n = 1; n <= LOCAL_ASSET_PAGE_SIZE + 1; n += 1) {
      seedAudio(store, n, {durationSeconds: n / 10});
    }

    const last = audioRef(LOCAL_ASSET_PAGE_SIZE + 1);
    const firstPage = await listLocalAssetPage(store, "audio");

    assert.equal(firstPage.entries.some((entry) => entry.ref === last), false);

    store.resetReads();

    const durations = await readAudioDurations(store, [last, audioRef(900), last]);

    assert.deepEqual(durations, {[last]: (LOCAL_ASSET_PAGE_SIZE + 1) / 10});
    assert.equal(store.reads.assets, 2);
    assert.equal(store.reads.payloadMeta, 1);
  });

  it("readAudioDurations drops NaN, Infinity, zero and negative durations even from a foreign store", async () => {
    const meta = (durationSeconds) => ({status: "present", value: {...audioMeta, durationSeconds}});
    const foreignStore = {
      getAssetRow: async () => ({status: "present", value: validRow}),
      getPayloadMeta: async (digest) => meta([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 0.005][Number.parseInt(digest.slice(-1), 16) - 1]),
    };
    const refs = [1, 2, 3, 4, 5].map(audioRef);

    assert.deepEqual(await readAudioDurations(foreignStore, refs), {[audioRef(5)]: 0.005});
  });

  it("readWaveform returns the record or null", async () => {
    const store = createMemoryAssetStore();

    store.setRaw("waveforms", DIGEST, {peaksPerSecond: 50, peaks});
    store.setRaw("waveforms", digestOf(2), {peaksPerSecond: 0, peaks});

    assert.deepEqual(await readWaveform(store, DIGEST), {peaksPerSecond: 50, peaks});
    assert.equal(await readWaveform(store, digestOf(2)), null);
    assert.equal(await readWaveform(store, digestOf(3)), null);
  });

  it("rename and delete work on audio refs through the library and announce ref and digest", async () => {
    const library = makeLibrary();

    await library.store.apply(audioMutation());

    assert.deepEqual(await renameLocalAsset(library, audioRef(1), "  Narration  "), {kind: "renamed", ref: audioRef(1)});
    assert.equal(library.store.getRaw("assets", audioRef(1)).label, "Narration");
    assert.deepEqual(await deleteLocalAsset(library, audioRef(1)), {kind: "deleted", ref: audioRef(1), payloadRemoved: true});
    assert.deepEqual(library.posted.at(-1), {type: "asset-library-changed", refs: [audioRef(1)], digests: [DIGEST]});
    assert.equal(await countLocalAssets(library.store, "audio"), 0);
  });
});
