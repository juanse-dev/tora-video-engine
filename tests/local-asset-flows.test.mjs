import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {buildLocalAssetRef} from "../src/localAssets/refs.ts";
import {
  importPhaseText,
  importSuccessText,
  runLocalAssetImport,
  withImportLock,
} from "../src/web/localAssetImportFlow.ts";
import {
  DELETE_FAILED_MESSAGE,
  RENAME_FAILED_MESSAGE,
  RENAME_NOT_FOUND_MESSAGE,
  deleteAssetFlow,
  libraryFromContext,
  renameAssetFlow,
} from "../src/web/localAssetManageFlow.ts";
import {
  buildApng,
  buildGifSignature,
  buildPng,
} from "./helpers/imageBytes.mjs";
import {
  createMemoryAssetStore,
  createMemoryLockManager,
} from "./helpers/memoryAssetStore.mjs";

const PNG = buildPng({width: 10, height: 20});

const thumbnail = () => ({
  blob: new Blob([buildPng({width: 64, height: 32})], {type: "image/png"}),
  mimeType: "image/png",
  width: 64,
  height: 32,
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

const imageDeps = () => ({
  decode: async () => ({width: 10, height: 20, close() {}}),
  makeThumbnail: async () => thumbnail(),
  storage: undefined,
});

const makeImport = (library, overrides = {}) => {
  const events = [];

  return {
    events,
    run: (bytes = PNG, name = "My Cat.png") =>
      runLocalAssetImport({
        file: new File([bytes], name),
        category: "pose",
        library,
        setInFlight: (value) => events.push(`inFlight:${value}`),
        onPhase: (phase) => events.push(`phase:${phase}`),
        apply: (ref) => events.push(`apply:${ref}`),
        deps: imageDeps(),
        ...overrides,
      }),
  };
};

describe("ASSET-003 import copy", () => {
  it("maps the import phases to the spec's progress text (R5)", () => {
    assert.equal(importPhaseText("reading"), "Reading…");
    assert.equal(importPhaseText("validating"), "Checking…");
    assert.equal(importPhaseText("hashing"), "Hashing…");
    assert.equal(importPhaseText("storing"), "Saving…");
  });

  it("words the success message by whether the row was created", () => {
    assert.equal(importSuccessText("My cat", true), 'Imported "My cat".');
    assert.equal(
      importSuccessText("My cat", false),
      '"My cat" was already in My assets; its stored copy was refreshed.',
    );
  });
});

describe("ASSET-003 import lock", () => {
  it("sets the flag before the body and clears it afterwards", async () => {
    const events = [];

    const result = await withImportLock(
      (value) => events.push(`inFlight:${value}`),
      async () => {
        events.push("body");

        return 42;
      },
    );

    assert.equal(result, 42);
    assert.deepEqual(events, ["inFlight:true", "body", "inFlight:false"]);
  });

  it("clears the flag when the body throws", async () => {
    const events = [];

    await assert.rejects(
      withImportLock(
        (value) => events.push(value),
        async () => {
          throw new Error("boom");
        },
      ),
      /boom/u,
    );
    assert.deepEqual(events, [true, false]);
  });

  it("keeps the flag when the caller takes over the release (mismatch dialog)", async () => {
    const events = [];

    await withImportLock(
      (value) => events.push(value),
      async () => "dialog",
      (result) => result !== "dialog",
    );
    assert.deepEqual(events, [true]);
  });
});

describe("ASSET-003 import pipeline", () => {
  it("locks, reports every phase, applies the ref before unlocking and posts the change", async () => {
    const library = makeLibrary();
    const {events, run} = makeImport(library);
    const result = await run();

    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.label, "My Cat");
    assert.equal(result.message, 'Imported "My Cat".');
    assert.equal(result.ref.startsWith("local:pose:sha256:"), true);
    assert.deepEqual(events, [
      "inFlight:true",
      "phase:reading",
      "phase:validating",
      "phase:hashing",
      "phase:storing",
      `apply:${result.ref}`,
      "inFlight:false",
    ]);
    assert.equal(library.posted.length, 1);
    assert.equal(library.store.applyCalls.length, 1);
  });

  it("importing the same file again reports the stored (possibly renamed) label", async () => {
    const library = makeLibrary();
    const first = await makeImport(library).run();

    await renameAssetFlow(library, first.ref, "Renamed cat");

    const second = await makeImport(library).run();

    assert.equal(second.ok, true);
    assert.equal(second.created, false);
    assert.equal(second.ref, first.ref);
    assert.equal(
      second.message,
      '"Renamed cat" was already in My assets; its stored copy was refreshed.',
    );
  });

  for (const [name, bytes, expected] of [
    ["an APNG", buildApng({width: 10, height: 20}), /animated/iu],
    ["a GIF", buildGifSignature(), /Only static PNG, JPEG and WebP/u],
  ]) {
    it(`rejects ${name} with a message, writes nothing and still unlocks`, async () => {
      const library = makeLibrary();
      const {events, run} = makeImport(library);
      const result = await run(bytes, "x.png");

      assert.equal(result.ok, false);
      assert.match(result.message, expected);
      assert.equal(library.store.applyCalls.length, 0);
      assert.deepEqual(library.posted, []);
      assert.equal(events.some((event) => event.startsWith("apply:")), false);
      assert.equal(events[0], "inFlight:true");
      assert.equal(events.at(-1), "inFlight:false");
    });
  }

  it("rejects a file over the size limit before reading it", async () => {
    const library = makeLibrary();
    const events = [];
    const file = new File([PNG], "big.png");

    Object.defineProperty(file, "size", {value: 25 * 1024 * 1024 + 1});

    const result = await runLocalAssetImport({
      file,
      category: "pose",
      library,
      setInFlight: (value) => events.push(`inFlight:${value}`),
      apply: () => events.push("apply"),
      deps: imageDeps(),
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /larger than 25 MiB/u);
    assert.deepEqual(events, ["inFlight:true", "inFlight:false"]);
  });

  it("reports a storage failure and applies nothing", async () => {
    const library = makeLibrary();
    const {events, run} = makeImport(library);

    library.store.failNextApply();

    const result = await run();

    assert.equal(result.ok, false);
    assert.match(result.message, /storage/iu);
    assert.equal(events.some((event) => event.startsWith("apply:")), false);
    assert.equal(events.at(-1), "inFlight:false");
  });

  it("turns an unexpected error into a generic message and still unlocks", async () => {
    const library = makeLibrary();
    const {events, run} = makeImport(library, {
      deps: {
        ...imageDeps(),
        decode: async () => {
          throw new Error("raw internal detail");
        },
      },
    });
    const result = await run();

    assert.equal(result.ok, false);
    assert.equal(result.message.includes("raw internal detail"), false);
    assert.equal(events.at(-1), "inFlight:false");
  });

  it("releases the lock even when applying the ref throws", async () => {
    const library = makeLibrary();
    const events = [];

    await assert.rejects(
      runLocalAssetImport({
        file: new File([PNG], "a.png"),
        category: "pose",
        library,
        setInFlight: (value) => events.push(value),
        apply: () => {
          throw new Error("apply failed");
        },
        deps: imageDeps(),
      }),
      /apply failed/u,
    );
    assert.deepEqual(events, [true, false]);
  });
});

describe("ASSET-003 library handle", () => {
  it("is only available while My assets is ready and Web Locks exist", () => {
    const store = createMemoryAssetStore();
    const locks = createMemoryLockManager();
    const channel = {post() {}};

    assert.deepEqual(
      libraryFromContext({status: {kind: "ready", store}, locks, channel}),
      {store, locks, channel},
    );
    assert.equal(
      libraryFromContext({status: {kind: "ready", store}, locks: undefined, channel}),
      null,
    );
    assert.equal(
      libraryFromContext({status: {kind: "disabled", message: "x"}, locks, channel}),
      null,
    );
    assert.equal(
      libraryFromContext({status: {kind: "unavailable", message: "x"}, locks, channel}),
      null,
    );
  });
});

describe("ASSET-003 rename and delete flows", () => {
  const seed = async (library) => {
    const result = await makeImport(library).run();

    library.posted.length = 0;

    return result.ref;
  };

  it("renames, trims and announces the change", async () => {
    const library = makeLibrary();
    const ref = await seed(library);
    const outcome = await renameAssetFlow(library, ref, "  Better name  ");

    assert.deepEqual(outcome, {kind: "renamed", label: "Better name"});
    assert.equal(library.posted.length, 1);
    assert.equal((await library.store.getAssetRow(ref)).value.label, "Better name");
  });

  it("returns the validation message for an invalid label without touching the library", async () => {
    const library = makeLibrary();
    const ref = await seed(library);

    assert.deepEqual(await renameAssetFlow(library, ref, "   "), {
      kind: "invalid",
      message: "Enter a name for this asset.",
    });
    assert.deepEqual(await renameAssetFlow(library, ref, "x".repeat(81)), {
      kind: "invalid",
      message: "Names can be at most 80 characters.",
    });
    assert.equal(library.store.applyCalls.length, 1); // only the import
    assert.deepEqual(library.posted, []);
  });

  it("reports not-found when the asset was deleted elsewhere", async () => {
    const library = makeLibrary();
    const missing = buildLocalAssetRef("pose", "a".repeat(64));

    assert.deepEqual(await renameAssetFlow(library, missing, "Name"), {
      kind: "not-found",
      message: RENAME_NOT_FOUND_MESSAGE,
    });
    assert.equal(RENAME_NOT_FOUND_MESSAGE, "This asset was deleted in another tab.");
  });

  it("maps a storage failure to a friendly rename message", async () => {
    const library = makeLibrary();
    const ref = await seed(library);

    library.store.failNextApply();

    const outcome = await renameAssetFlow(library, ref, "New");

    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.message, RENAME_FAILED_MESSAGE);
  });

  it("deletes the asset and announces the change", async () => {
    const library = makeLibrary();
    const ref = await seed(library);

    assert.equal(await deleteAssetFlow(library, ref), "deleted");
    assert.equal((await library.store.getAssetRow(ref)).status, "absent");
    assert.equal(library.posted.length, 1);
  });

  it("treats an already-deleted asset as deleted", async () => {
    const library = makeLibrary();
    const missing = buildLocalAssetRef("pose", "b".repeat(64));

    assert.equal(await deleteAssetFlow(library, missing), "not-found");
    assert.deepEqual(library.posted, []);
  });

  it("throws a friendly error when the delete fails", async () => {
    const library = makeLibrary();
    const ref = await seed(library);

    library.store.failNextApply();
    await assert.rejects(
      deleteAssetFlow(library, ref),
      (error) =>
        error instanceof Error && error.message === DELETE_FAILED_MESSAGE,
    );
  });
});
