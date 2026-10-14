import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {sha256Hex} from "../src/localAssets/hash.ts";
import {
  AUDIO_CHANNELS_MESSAGE,
  AUDIO_EMPTY_MESSAGE,
  AUDIO_TOO_LARGE_MESSAGE,
  AUDIO_TOO_LONG_MESSAGE,
  AUDIO_UNSUPPORTED_MESSAGE,
  AUDIO_VIDEO_MESSAGE,
} from "../src/localAssets/audioInspection.ts";
import {buildLocalAssetRef} from "../src/localAssets/refs.ts";
import {
  commitPreparedLocalAssetImport,
  importLocalAsset,
  LocalAssetImportError,
  prepareLocalAssetImport,
} from "../src/web/assetLibrary/importAsset.ts";
import {
  AUDIO_DECODE_FAILED_MESSAGE,
  AUDIO_TRUNCATED_MESSAGE,
} from "../src/web/assetLibrary/importAudio.ts";
import {
  importPhaseText,
  importSuccessText,
  runLocalAssetImport,
  runMatchingFileImport,
} from "../src/web/localAssetImportFlow.ts";
import {buildWav, fixtureBytes} from "./helpers/audioBytes.mjs";
import {
  createMemoryAssetStore,
  createMemoryLockManager,
} from "./helpers/memoryAssetStore.mjs";

const MIB = 1024 * 1024;
const fileOf = (name, bytes) => new File([bytes], name);
const fixtureFile = (name) => fileOf(name, fixtureBytes(name));
const complete = (seconds) => async () => ({
  decodedSeconds: seconds,
  peaks: Uint8Array.from([1, 2, 3, 255]),
  peaksPerSecond: 50,
});
const makeLibrary = () => {
  const posted = [];

  return {
    store: createMemoryAssetStore(),
    locks: createMemoryLockManager(),
    posted,
    channel: {post: (message) => posted.push(message)},
  };
};
const spies = () => {
  const calls = {decode: 0, digest: 0};

  return {
    calls,
    deps: {
      decodePeaks: async (...args) => {
        calls.decode += 1;
        return complete(2.2)(...args);
      },
      subtle: {
        digest: (algorithm, data) => {
          calls.digest += 1;
          return globalThis.crypto.subtle.digest(algorithm, data);
        },
      },
    },
  };
};
const rejection = async (promise) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof LocalAssetImportError, String(error));

    return error;
  }

  assert.fail("expected a LocalAssetImportError");
};

describe("prepareLocalAssetImport for audio", () => {
  it("inspects, decodes and hashes the same bytes and builds the prepared import in phase order", async () => {
    const phases = [];
    const bytes = fixtureBytes("tone-440-2.2s.wav");
    const prepared = await prepareLocalAssetImport(fileOf("My voice.wav", bytes), "audio", {
      decodePeaks: complete(2.2),
      onPhase: (phase) => phases.push(phase),
    });
    const digest = await sha256Hex(bytes);

    assert.deepEqual(phases, ["reading", "validating", "decoding", "hashing"]);
    assert.equal(prepared.ref, buildLocalAssetRef("audio", digest));
    assert.equal(prepared.defaultLabel, "My voice");
    assert.equal(prepared.originalFilename, "My voice.wav");
    assert.deepEqual(prepared.payloadMeta, {
      kind: "audio",
      mimeType: "audio/wav",
      byteSize: bytes.length,
      container: "wave",
      codec: "pcm",
      durationSeconds: 2.2,
      sampleRate: 48_000,
      channels: 2,
    });
    assert.deepEqual(prepared.waveform, {peaksPerSecond: 50, peaks: Uint8Array.from([1, 2, 3, 255])});
    assert.equal(prepared.blob.type, "audio/wav");
    assert.deepEqual(new Uint8Array(await prepared.blob.arrayBuffer()), bytes);
  });

  it("chooses the payload MIME type from the inspected container, never from the file's own type", async () => {
    const file = new File([fixtureBytes("tone-440-2.2s.opus.ogg")], "voice.mp3", {type: "audio/mpeg"});
    const prepared = await prepareLocalAssetImport(file, "audio", {decodePeaks: complete(2.2135)});

    assert.equal(prepared.payloadMeta.mimeType, "audio/ogg");
    assert.equal(prepared.payloadMeta.container, "ogg");
    assert.equal(prepared.blob.type, "audio/ogg");
    assert.equal(prepared.defaultLabel, "voice");
  });

  it("really decodes a PCM WAV in Node and returns peaks near full scale", async () => {
    const prepared = await prepareLocalAssetImport(fixtureFile("tone-440-2.2s.wav"), "audio");

    assert.equal(prepared.waveform.peaks.length, 111);
    assert.equal(Math.min(...prepared.waveform.peaks) >= 250, true);
    assert.equal(prepared.waveform.peaksPerSecond, 111 / 2.2);
  });

  it("falls back to 'Untitled audio' and caps long names at 80 code points", async () => {
    const dotted = await prepareLocalAssetImport(fileOf(".wav", fixtureBytes("tone-880-0.4s.wav")), "audio", {decodePeaks: complete(0.4)});
    const long = await prepareLocalAssetImport(fileOf(`${"x".repeat(100)}.wav`, fixtureBytes("tone-880-0.4s.wav")), "audio", {decodePeaks: complete(0.4)});

    assert.equal(dotted.defaultLabel, "Untitled audio");
    assert.equal(long.defaultLabel, "x".repeat(80));
  });

  it("accepts a 30 MiB WAV (the audio limit) and rejects 51 MiB without reading or hashing a byte", async () => {
    const big = buildWav({dataBytes: 30 * MIB - 44});
    const accepted = await prepareLocalAssetImport(fileOf("big.wav", big), "audio", {decodePeaks: complete(163.84)});

    assert.equal(accepted.payloadMeta.byteSize, 30 * MIB);

    const huge = fileOf("huge.wav", buildWav({dataBytes: 51 * MIB - 44}));
    const state = {reads: 0};
    const { calls, deps } = spies();

    huge.arrayBuffer = async () => {
      state.reads += 1;
      return new ArrayBuffer(0);
    };

    const error = await rejection(prepareLocalAssetImport(huge, "audio", deps));

    assert.equal(error.code, "too-large");
    assert.equal(error.message, AUDIO_TOO_LARGE_MESSAGE);
    assert.equal(state.reads, 0);
    assert.deepEqual(calls, {decode: 0, digest: 0});
  });

  it("an empty file is empty and is never read", async () => {
    const error = await rejection(prepareLocalAssetImport(fileOf("empty.wav", new Uint8Array(0)), "audio", spies().deps));

    assert.equal(error.code, "empty");
    assert.equal(error.message, AUDIO_EMPTY_MESSAGE);
  });

  for (const [name, message] of [
    ["not-audio.txt", AUDIO_UNSUPPORTED_MESSAGE],
    ["with-video.mp4", AUDIO_VIDEO_MESSAGE],
    ["long-301s.mp3", AUDIO_TOO_LONG_MESSAGE],
    ["three-channel.wav", "Audio must be mono or stereo."],
    ["zero-channel.wav", "Audio must be mono or stereo."],
  ]) {
    it(`rejects ${name} with its message, before any decode or hash`, async () => {
      const { calls, deps } = spies();
      const error = await rejection(prepareLocalAssetImport(fixtureFile(name), "audio", deps));

      assert.equal(error.code, "audio-rejected");
      assert.equal(error.message, message);
      assert.deepEqual(calls, {decode: 0, digest: 0});
    });
  }

  it("a decoder failure is 'could not be decoded' and nothing is hashed", async () => {
    const { calls, deps } = spies();
    const error = await rejection(
      prepareLocalAssetImport(fixtureFile("tone-440-2.2s.mp3"), "audio", {
        ...deps,
        decodePeaks: async () => {
          throw new Error("codec unsupported");
        },
      }),
    );

    assert.equal(error.code, "audio-decode-failed");
    assert.equal(error.message, AUDIO_DECODE_FAILED_MESSAGE);
    assert.equal(error.message, "This audio file could not be decoded.");
    assert.equal(calls.digest, 0);
  });

  it("the truncation rule rejects a short decode and a zero-sample decode", async () => {
    const truncated = await rejection(
      prepareLocalAssetImport(fixtureFile("truncated.mp3"), "audio", {decodePeaks: complete(5.98)}),
    );
    const silent = await rejection(
      prepareLocalAssetImport(fixtureFile("tone-880-0.4s.wav"), "audio", {decodePeaks: complete(0)}),
    );

    assert.equal(truncated.code, "audio-truncated");
    assert.equal(truncated.message, AUDIO_TRUNCATED_MESSAGE);
    assert.equal(truncated.message, "This audio file looks truncated.");
    assert.equal(silent.code, "audio-truncated");
    assert.equal((await prepareLocalAssetImport(fixtureFile("truncated.mp3"), "audio", {decodePeaks: complete(9.9)})).payloadMeta.durationSeconds > 10, true);
  });

  it("an unreadable file and a failing digest are import errors with audio wording", async () => {
    const unreadable = fixtureFile("tone-440-2.2s.wav");

    unreadable.arrayBuffer = async () => {
      throw new Error("disk");
    };

    assert.equal((await rejection(prepareLocalAssetImport(unreadable, "audio"))).message, "The file could not be read.");

    const broken = await rejection(
      prepareLocalAssetImport(fixtureFile("tone-440-2.2s.wav"), "audio", {
        decodePeaks: complete(2.2),
        subtle: {digest: async () => { throw new Error("no crypto"); }},
      }),
    );

    assert.equal(broken.code, "storage-error");
    assert.equal(broken.message, "The audio file could not be fingerprinted in this browser.");
  });
});

describe("committing an audio import", () => {
  const prepare = (name = "tone-440-2.2s.wav", duration = 2.2) =>
    prepareLocalAssetImport(fixtureFile(name), "audio", {decodePeaks: complete(duration)});

  it("writes row, metadata, bytes and waveform in one apply and announces the change", async () => {
    const library = makeLibrary();
    const prepared = await prepare();
    const digest = prepared.ref.slice(-64);
    const result = await commitPreparedLocalAssetImport(prepared, library);

    assert.deepEqual(result, {ref: prepared.ref, created: true});
    assert.equal(library.store.applyCalls.length, 1);
    assert.equal(library.store.applyCalls[0].kind, "import-audio");
    assert.equal(library.store.getRaw("assets", prepared.ref).label, "tone-440-2.2s");
    assert.equal(library.store.getRaw("payloadMeta", digest).kind, "audio");
    assert.equal(library.store.hasRaw("blobs", digest), true);
    assert.deepEqual(Object.keys(library.store.getRaw("waveforms", digest)).sort(), ["peaks", "peaksPerSecond"]);
    assert.equal(library.store.stores.thumbnails.size, 0);
    assert.deepEqual(library.posted, [{type: "asset-library-changed", refs: [prepared.ref], digests: [digest]}]);
    assert.deepEqual(await commitPreparedLocalAssetImport(prepared, library), {ref: prepared.ref, created: false});
  });

  it("an aborted signal cancels the wait for the lock and writes nothing", async () => {
    const library = makeLibrary();
    const prepared = await prepare();
    const controller = new AbortController();

    controller.abort();

    const error = await rejection(commitPreparedLocalAssetImport(prepared, library, {signal: controller.signal}));

    assert.equal(error.code, "cancelled");
    assert.equal(library.store.applyCalls.length, 0);
  });

  it("maps quota and other storage failures to audio-worded errors", async () => {
    const library = makeLibrary();
    const prepared = await prepare();

    library.store.failNextApply();

    const full = await rejection(commitPreparedLocalAssetImport(prepared, library));

    assert.equal(full.code, "storage-full");
    assert.equal(full.message, "There is not enough browser storage left for this audio file.");

    library.store.failNextApply(new Error("disk"));

    const failed = await rejection(commitPreparedLocalAssetImport(prepared, library));

    assert.equal(failed.code, "storage-error");
    assert.equal(failed.message, "The audio file could not be saved to browser storage.");
  });

  it("importLocalAsset runs prepare, 'storing' and commit", async () => {
    const library = makeLibrary();
    const phases = [];
    const result = await importLocalAsset(fixtureFile("tone-440-2.2s.wav"), "audio", library, {
      decodePeaks: complete(2.2),
      onPhase: (phase) => phases.push(phase),
    });

    assert.equal(result.created, true);
    assert.deepEqual(phases, ["reading", "validating", "decoding", "hashing", "storing"]);
  });
});

describe("audio in the import flows", () => {
  it("has the copy of the spec", () => {
    assert.equal(importPhaseText("decoding"), "Decoding…");
    assert.equal(importSuccessText("Voice", true, "audio"), 'Imported "Voice".');
    assert.equal(importSuccessText("Voice", false, "audio"), '"Voice" was already in My audio; its stored copy was refreshed.');
    assert.equal(importSuccessText("Hero", false), '"Hero" was already in My assets; its stored copy was refreshed.');
    assert.equal(importSuccessText("Hero", false, "pose"), '"Hero" was already in My assets; its stored copy was refreshed.');
  });

  it("runLocalAssetImport imports, deduplicates and applies the ref after the commit", async () => {
    const library = makeLibrary();
    const inFlight = [];
    const applied = [];
    const run = () =>
      runLocalAssetImport({
        file: fixtureFile("tone-440-2.2s.wav"),
        category: "audio",
        library,
        setInFlight: (value) => inFlight.push(value),
        apply: (ref) => applied.push(ref),
        deps: {decodePeaks: complete(2.2)},
      });
    const first = await run();
    const second = await run();

    assert.equal(first.ok, true);
    assert.equal(first.message, 'Imported "tone-440-2.2s".');
    assert.equal(second.ok, true);
    assert.equal(second.created, false);
    assert.equal(second.message, '"tone-440-2.2s" was already in My audio; its stored copy was refreshed.');
    assert.deepEqual(inFlight, [true, false, true, false]);
    assert.equal(applied.length, 2);
  });

  it("a rejected file leaves the store untouched and releases the lock", async () => {
    const library = makeLibrary();
    const inFlight = [];
    const result = await runLocalAssetImport({
      file: fixtureFile("three-channel.wav"),
      category: "audio",
      library,
      setInFlight: (value) => inFlight.push(value),
      apply: () => assert.fail("must not apply"),
    });

    assert.deepEqual([result.ok, result.message], [false, AUDIO_CHANNELS_MESSAGE]);
    assert.deepEqual(inFlight, [true, false]);
    assert.equal(library.store.applyCalls.length, 0);
  });

  it("Import matching file: the exact file restores the ref; a different audio file is refused with the mismatch text and writes nothing", async () => {
    const wav = fixtureBytes("tone-440-2.2s.wav");
    const missingRef = buildLocalAssetRef("audio", await sha256Hex(wav));
    const library = makeLibrary();
    const dialogs = [];
    const run = (file) =>
      runMatchingFileImport({
        file,
        category: "audio",
        missingRef,
        library,
        setInFlight: () => {},
        openMismatchDialog: (dialog) => {
          dialogs.push(dialog);
          return true;
        },
        apply: () => assert.fail("must not apply"),
        deps: {decodePeaks: complete(2.2)},
      });
    const different = await run(fixtureFile("tone-880-0.4s.wav"));

    assert.equal(different.kind, "failed");
    assert.match(different.message, /^This file is a different audio file \([0-9a-f]{4}…[0-9a-f]{4}\), so it can't restore the missing one\.$/u);
    assert.equal(dialogs.length, 0);
    assert.equal(library.store.applyCalls.length, 0);

    const restored = await run(fixtureFile("tone-440-2.2s.wav"));

    assert.equal(restored.kind, "restored");
    assert.equal(restored.ref, missingRef);
    assert.equal(restored.message, 'Imported "tone-440-2.2s".');
    assert.equal(library.store.applyCalls.length, 1);
  });
});
