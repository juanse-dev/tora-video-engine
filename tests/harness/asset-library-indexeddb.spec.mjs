import {expect, test} from "@playwright/test";

const HARNESS_URL = "/tests/harness/asset-library.html";
const LOCK_NAME = "tora-video-engine:asset-library";
const BLOCKED_MESSAGE = "Close other Tora tabs to finish updating My assets.";
const STORE_NAMES = ["assets", "blobs", "payloadMeta", "thumbnails"];

const openHarnessPage = async (context) => {
  const page = await context.newPage();
  const errors = [];

  page.on("pageerror", (error) => errors.push(error.message));
  page.errors = errors;
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => window.toraHarness !== undefined);
  return page;
};

const harness = (page, method, ...args) =>
  page.evaluate(
    ([name, parameters]) => window.toraHarness[name](...parameters),
    [method, args],
  );

const digestFor = (index) => index.toString(16).padStart(64, "0");
const poseRef = (index) => `local:pose:sha256:${digestFor(index)}`;
const validRow = (index) => ({
  label: `Pose ${index}`,
  originalFilename: `pose-${index}.png`,
  createdAt: "2026-01-01T00:00:00.000Z",
});

test.describe("IndexedDB asset library", () => {
  test("open creates exactly the four out-of-line-key stores", async ({
    context,
  }) => {
    const page = await openHarnessPage(context);

    expect(await harness(page, "openLibrary")).toEqual({kind: "ready"});

    const schema = await harness(page, "rawSchema");

    expect(schema.version).toBe(1);
    expect(schema.stores.map((store) => store.name).sort()).toEqual(
      STORE_NAMES,
    );

    for (const store of schema.stores) {
      expect(store.keyPath).toBeNull();
      expect(store.autoIncrement).toBe(false);
      expect(store.indexNames).toEqual([]);
    }

    expect(page.errors).toEqual([]);
  });

  test("import, rename and delete round-trip through real IndexedDB", async ({
    context,
  }) => {
    const page = await openHarnessPage(context);

    await harness(page, "openLibrary");

    const pose = await harness(page, "seedImage", {
      category: "pose",
      label: "Original name",
      originalFilename: "me.png",
    });

    expect(pose.result).toEqual({
      kind: "imported",
      ref: pose.ref,
      created: true,
    });

    const stored = await harness(page, "inspectRef", pose.ref);

    expect(stored.row.status).toBe("present");
    expect(stored.row.value).toMatchObject({
      label: "Original name",
      originalFilename: "me.png",
    });
    expect(stored.meta).toEqual({
      status: "present",
      value: {mimeType: "image/png", byteSize: expect.any(Number), width: 16, height: 16},
    });
    expect(stored.blob).toMatchObject({
      status: "present",
      type: "image/png",
      size: stored.meta.value.byteSize,
      sha256: pose.digest,
    });
    expect(stored.thumbnail).toMatchObject({
      status: "present",
      mimeType: "image/png",
      width: 32,
      height: 32,
    });

    // The same bytes as a background share one payload.
    const background = await harness(page, "seedImage", {
      category: "background",
    });

    expect(background.digest).toBe(pose.digest);
    expect(background.result.created).toBe(true);
    expect(await harness(page, "count", "pose")).toBe(1);
    expect(await harness(page, "count", "background")).toBe(1);

    // Re-importing an existing row keeps its label and createdAt.
    expect(await harness(page, "rename", pose.ref, "  Renamed  ")).toEqual({
      kind: "renamed",
      ref: pose.ref,
    });
    const again = await harness(page, "seedImage", {
      category: "pose",
      label: "Fresh default",
    });

    expect(again.result.created).toBe(false);
    expect((await harness(page, "inspectRef", pose.ref)).row.value).toMatchObject({
      label: "Renamed",
      createdAt: stored.row.value.createdAt,
    });

    const missing = poseRef(0xabc);

    expect(await harness(page, "rename", missing, "Nope")).toEqual({
      kind: "not-found",
      ref: missing,
    });

    // Deleting one category keeps the shared payload; deleting the last removes it.
    expect(await harness(page, "remove", pose.ref)).toEqual({
      kind: "deleted",
      ref: pose.ref,
      payloadRemoved: false,
    });
    expect((await harness(page, "inspectRef", pose.ref)).row.status).toBe("absent");
    expect((await harness(page, "inspectRef", pose.ref)).blob.status).toBe("present");

    expect(await harness(page, "remove", background.ref)).toEqual({
      kind: "deleted",
      ref: background.ref,
      payloadRemoved: true,
    });

    const snapshot = await harness(page, "rawKeySnapshot");

    for (const name of STORE_NAMES) {
      expect(snapshot[name]).toEqual([]);
    }

    expect(await harness(page, "remove", pose.ref)).toEqual({
      kind: "not-found",
      ref: pose.ref,
    });
    expect(page.errors).toEqual([]);
  });

  test("data survives a page reload", async ({context}) => {
    const page = await openHarnessPage(context);

    await harness(page, "openLibrary");

    const pose = await harness(page, "seedImage", {
      category: "pose",
      label: "Persistent",
    });

    await page.reload();
    await page.waitForFunction(() => window.toraHarness !== undefined);
    expect(await harness(page, "openLibrary")).toEqual({kind: "ready"});

    const stored = await harness(page, "inspectRef", pose.ref);

    expect(stored.row.value.label).toBe("Persistent");
    expect(stored.blob.sha256).toBe(pose.digest);
    expect((await harness(page, "listPage", "pose")).refs).toEqual([pose.ref]);
  });

  test("a connection closes itself when another tab upgrades the database", async ({
    context,
  }) => {
    const pageA = await openHarnessPage(context);
    const pageB = await openHarnessPage(context);

    await harness(pageA, "openLibrary");

    const pose = await harness(pageA, "seedImage", {category: "pose"});

    // Page B opens version 2 directly. It is not blocked: A closes on versionchange.
    expect(await harness(pageB, "upgradeDatabaseTo", 2)).toBe(2);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const probe = await harness(pageA, "probeRead", pose.ref);

      expect(probe.ok).toBe(false);
      expect(probe.error.message).toMatch(/upgraded in another tab/i);
      expect(probe.error.message).toMatch(/reload/i);
    }

    // A fresh page against a newer database than this build knows is unavailable, not a crash.
    await pageA.reload();
    await pageA.waitForFunction(() => window.toraHarness !== undefined);

    const status = await harness(pageA, "openLibrary");

    expect(status.kind).toBe("unavailable");
    expect(status.message).toMatch(/reload|update/i);
    expect(await pageA.evaluate(() => window.toraHarness.lockState())).toEqual({
      held: [],
      pending: [],
    });
  });

  test("a blocked upgrade keeps the lock, reports unavailable, then becomes ready", async ({
    context,
  }) => {
    const pageA = await openHarnessPage(context);
    const pageB = await openHarnessPage(context);

    await harness(pageA, "openLibrary");

    const pose = await harness(pageA, "seedImage", {category: "pose"});

    // A keeps a raw connection that ignores versionchange.
    await harness(pageA, "closeLibrary");
    expect(await harness(pageA, "holdStubbornConnection")).toBe(1);

    const first = await harness(pageB, "openLibrary", {version: 2});

    expect(first).toEqual({kind: "unavailable", message: BLOCKED_MESSAGE});

    // B still holds the exclusive library lock while its open request is alive.
    expect(await harness(pageB, "lockState")).toEqual({
      held: ["exclusive"],
      pending: [],
    });
    expect(
      await pageA.evaluate(
        (name) =>
          navigator.locks.request(name, {ifAvailable: true}, (lock) => lock !== null),
        LOCK_NAME,
      ),
    ).toBe(false);
    expect(await harness(pageB, "currentStatus")).toEqual({
      kind: "unavailable",
      message: BLOCKED_MESSAGE,
    });

    // Once A lets go, the upgrade finishes inside the held lock and B becomes ready.
    await harness(pageA, "releaseStubbornConnection");
    await harness(pageB, "waitForStatus", "ready");

    expect((await harness(pageB, "rawSchema")).version).toBe(2);
    await expect
      .poll(() => harness(pageB, "lockState"))
      .toEqual({held: [], pending: []});

    const stored = await harness(pageB, "inspectRef", pose.ref);

    expect(stored.row.status).toBe("present");
    expect(pageA.errors).toEqual([]);
    expect(pageB.errors).toEqual([]);
  });

  test("opening the database waits for the exclusive library lock", async ({
    context,
  }) => {
    const pageA = await openHarnessPage(context);
    const pageB = await openHarnessPage(context);

    await harness(pageA, "holdLock", "exclusive");

    const opening = pageB.evaluate(() => window.toraHarness.openLibrary());

    await expect
      .poll(() => harness(pageB, "lockState"))
      .toEqual({held: ["exclusive"], pending: ["exclusive"]});
    expect(await harness(pageB, "databaseNames")).toEqual([]);

    await harness(pageA, "releaseLock");
    expect(await opening).toEqual({kind: "ready"});
    expect(await harness(pageB, "databaseNames")).toEqual([
      "tora-video-engine-assets",
    ]);
  });

  test.describe("corrupt thumbnails never reach an object URL", () => {
    const cases = [
      {kind: "claims-300", status: "corrupt"},
      {kind: "oversized", status: "corrupt"},
      {kind: "bytes-4000", status: "present"},
    ];

    for (const {kind, status} of cases) {
      test(`${kind} shows the neutral box`, async ({context}) => {
        const page = await openHarnessPage(context);

        await harness(page, "openLibrary");

        const pose = await harness(page, "seedImage", {
          category: "pose",
          thumbnail: kind,
        });

        expect((await harness(page, "inspectRef", pose.ref)).thumbnail.status).toBe(
          status,
        );
        expect(await harness(page, "renderCard", pose.ref)).toBe("neutral");
        expect(await harness(page, "objectUrlCalls")).toEqual([]);
        await expect(
          page.locator('[data-testid="asset-card"][data-state="neutral"]'),
        ).toHaveCount(1);
        await expect(page.locator("img")).toHaveCount(0);
      });
    }

    test("a valid thumbnail creates exactly one object URL", async ({
      context,
    }) => {
      const page = await openHarnessPage(context);

      await harness(page, "openLibrary");

      const pose = await harness(page, "seedImage", {category: "pose"});

      expect(await harness(page, "renderCard", pose.ref)).toBe("image");
      expect(await harness(page, "objectUrlCalls")).toHaveLength(1);
      await expect(page.locator("img")).toHaveCount(1);
    });
  });

  test("a transaction that throws mid-way leaves no partial record", async ({
    context,
  }) => {
    const page = await openHarnessPage(context);

    await harness(page, "openLibrary");

    const control = await harness(page, "seedImage", {
      category: "pose",
      color: "#112233",
    });
    const before = await harness(page, "rawKeySnapshot");
    const controlBefore = await harness(page, "inspectRef", control.ref);

    // assets and payloadMeta are written before the blob put throws a DataCloneError.
    const broken = await harness(page, "applyBrokenImport", {
      category: "pose",
      color: "#aabbcc",
    });

    expect(broken.ok).toBe(false);
    expect(broken.error).toMatchObject({code: "storage-error"});
    expect(await harness(page, "rawKeySnapshot")).toEqual(before);
    expect(await harness(page, "inspectRef", control.ref)).toEqual(controlBefore);

    // The store is still usable afterwards.
    const next = await harness(page, "seedImage", {
      category: "pose",
      color: "#aabbcc",
    });

    expect(next.result.created).toBe(true);
    expect(await harness(page, "count", "pose")).toBe(2);
  });

  test("paging reads one page at a time and skips non-canonical keys", async ({
    context,
  }) => {
    const page = await openHarnessPage(context);

    await harness(page, "openLibrary");

    const entries = [];

    for (let index = 0; index < 120; index += 1) {
      entries.push([poseRef(index), validRow(index)]);
    }

    // Canonical background rows must never appear in pose listings.
    const backgrounds = [];

    for (let index = 0; index < 5; index += 1) {
      backgrounds.push([
        `local:background:sha256:${digestFor(index)}`,
        validRow(index),
      ]);
    }

    // Non-canonical keys that sort INSIDE the first page's window.
    const strays = [
      "local:pose:sha256:", // empty digest, sorts before everything
      "local:pose:sha256:0000000000", // too short, sorts before the first row
      `${poseRef(0x1f).slice(0, -2)}1F`, // uppercase hex, between 0x19 and 0x1a
      `${poseRef(0x2f).slice(0, -2)}2g`, // non-hex character, between 0x2f and 0x30
      `${poseRef(0x20)}x`, // 65 characters, right after row 0x20
      `${poseRef(0x70)}x`, // non-canonical key in the last page
    ];

    await harness(page, "rawPut", "assets", [
      ...entries,
      ...backgrounds,
      ...strays.map((key) => [key, validRow(999)]),
    ]);
    await harness(page, "rawPut", "assets", [[poseRef(5), 42]]); // corrupt value

    // Direct store API: full pages of canonical rows, strays do not count toward the limit.
    const firstTen = await harness(page, "listStore", "pose", {}, 10);

    expect(firstTen.map((row) => row.ref)).toEqual(
      Array.from({length: 10}, (_, index) => poseRef(index)),
    );
    expect(firstTen[5].status).toBe("corrupt");
    expect(firstTen[4].status).toBe("present");

    const before48 = await harness(page, "listStore", "pose", {before: poseRef(0x30)}, 10);

    expect(before48.map((row) => row.ref)).toEqual(
      Array.from({length: 10}, (_, index) => poseRef(0x26 + index)),
    );

    const between = await harness(
      page,
      "listStore",
      "pose",
      {after: poseRef(0x18), before: poseRef(0x1c)},
      10,
    );

    expect(between.map((row) => row.ref)).toEqual([
      poseRef(0x19),
      poseRef(0x1a),
      poseRef(0x1b),
    ]);
    expect(await harness(page, "listStore", "pose", {}, 0)).toEqual([]);
    expect(await harness(page, "count", "pose")).toBe(120);
    expect(await harness(page, "count", "background")).toBe(5);

    // Library paging: 50 / 50 / 20, forwards and back.
    const pageOne = await harness(page, "listPage", "pose");

    expect(pageOne.refs).toEqual(
      Array.from({length: 50}, (_, index) => poseRef(index)),
    );
    expect([pageOne.hasPrevious, pageOne.hasNext]).toEqual([false, true]);

    const pageTwo = await harness(page, "listPage", "pose", {
      after: pageOne.refs.at(-1),
    });

    expect(pageTwo.refs).toEqual(
      Array.from({length: 50}, (_, index) => poseRef(50 + index)),
    );
    expect([pageTwo.hasPrevious, pageTwo.hasNext]).toEqual([true, true]);

    const pageThree = await harness(page, "listPage", "pose", {
      after: pageTwo.refs.at(-1),
    });

    expect(pageThree.refs).toEqual(
      Array.from({length: 20}, (_, index) => poseRef(100 + index)),
    );
    expect([pageThree.hasPrevious, pageThree.hasNext]).toEqual([true, false]);

    const backToTwo = await harness(page, "listPage", "pose", {
      before: pageThree.refs[0],
    });

    expect(backToTwo.refs).toEqual(pageTwo.refs);
    expect([backToTwo.hasPrevious, backToTwo.hasNext]).toEqual([true, true]);

    const backToOne = await harness(page, "listPage", "pose", {
      before: pageTwo.refs[0],
    });

    expect(backToOne.refs).toEqual(pageOne.refs);
    expect([backToOne.hasPrevious, backToOne.hasNext]).toEqual([false, true]);

    // Never a full-store read.
    expect(await harness(page, "getAllCalls")).toEqual([]);
  });

  test("without Web Locks the library is disabled and the database is never opened", async ({
    context,
  }) => {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "locks", {
        value: undefined,
        configurable: true,
      });
    });

    const page = await openHarnessPage(context);

    const status = await harness(page, "openLibrary");

    expect(status.kind).toBe("disabled");
    expect(status.message).toBe(
      "My assets needs a browser with Web Locks support. Local assets in this Story can't be shown or rendered here.",
    );
    expect(await harness(page, "databaseNames")).not.toContain(
      "tora-video-engine-assets",
    );
  });

  test("an exclusive mutation waits for a shared holder and notifies other tabs", async ({
    context,
  }) => {
    const pageA = await openHarnessPage(context);
    const pageB = await openHarnessPage(context);

    await harness(pageA, "openLibrary");
    await harness(pageB, "openLibrary");

    const pose = await harness(pageA, "seedImage", {
      category: "pose",
      label: "Before",
    });

    await harness(pageA, "holdLock", "shared");
    await harness(pageB, "startRename", pose.ref, "After");

    await expect
      .poll(() => harness(pageB, "lockState"))
      .toEqual({held: ["shared"], pending: ["exclusive"]});
    expect(await harness(pageB, "pendingMutation")).toEqual({state: "pending"});
    expect((await harness(pageA, "inspectRef", pose.ref)).row.value.label).toBe(
      "Before",
    );

    await harness(pageA, "releaseLock");
    await expect
      .poll(() => harness(pageB, "pendingMutation"))
      .toEqual({state: "done", result: {kind: "renamed", ref: pose.ref}});
    expect((await harness(pageA, "inspectRef", pose.ref)).row.value.label).toBe(
      "After",
    );

    await expect
      .poll(() => harness(pageA, "messages"))
      .toContainEqual({
        type: "asset-library-changed",
        refs: [pose.ref],
        digests: [pose.digest],
      });
  });

  test.describe("real import pipeline (default decode and thumbnail)", () => {
    const fixtures = [
      {
        file: "pose-magenta.png",
        category: "pose",
        mimeType: "image/png",
        width: 600,
        height: 900,
        thumbnail: {width: 171, height: 256},
      },
      {
        file: "background-cyan.jpg",
        category: "background",
        mimeType: "image/jpeg",
        width: 1080,
        height: 1920,
        thumbnail: {width: 144, height: 256},
      },
      {
        file: "background-noext",
        category: "background",
        mimeType: "image/webp",
        width: 1080,
        height: 1920,
        thumbnail: {width: 144, height: 256},
      },
    ];

    for (const fixture of fixtures) {
      test(`imports ${fixture.file} through real Chrome codecs`, async ({
        context,
      }) => {
        const page = await openHarnessPage(context);

        await harness(page, "openLibrary");

        const imported = await harness(
          page,
          "importFixture",
          fixture.file,
          fixture.category,
        );

        expect(imported.created).toBe(true);
        expect(imported.ref).toBe(
          `local:${fixture.category}:sha256:${imported.fixtureSha256}`,
        );
        expect(imported.header).toEqual({
          mimeType: fixture.mimeType,
          width: fixture.width,
          height: fixture.height,
        });

        const stored = await harness(page, "inspectRef", imported.ref);

        expect(stored.row.status).toBe("present");
        expect(stored.row.value.originalFilename).toBe(fixture.file);
        expect(stored.meta).toEqual({
          status: "present",
          value: {
            mimeType: imported.header.mimeType,
            byteSize: imported.fixtureByteSize,
            width: imported.header.width,
            height: imported.header.height,
          },
        });
        expect(stored.blob).toMatchObject({
          status: "present",
          type: fixture.mimeType,
          size: imported.fixtureByteSize,
          sha256: imported.fixtureSha256,
        });

        // The thumbnail is a separate, smaller derivative that keeps the
        // aspect ratio and is never upscaled.
        expect(stored.thumbnail.status).toBe("present");
        expect(["image/webp", "image/png"]).toContain(stored.thumbnail.mimeType);
        expect(stored.thumbnail.blobType).toBe(stored.thumbnail.mimeType);
        expect(stored.thumbnail.width).toBe(fixture.thumbnail.width);
        expect(stored.thumbnail.height).toBe(fixture.thumbnail.height);

        const display = await harness(page, "displayThumbnail", imported.ref);

        expect(display.ok).toBe(true);
        expect(display.type).toBe(stored.thumbnail.mimeType);

        const verified = await harness(page, "verify", imported.ref);

        expect(verified.ok).toBe(true);
        expect(verified.blobType).toBe(fixture.mimeType);
        expect(verified.payload).toEqual({
          digest: imported.fixtureSha256,
          mimeType: fixture.mimeType,
          byteSize: imported.fixtureByteSize,
          width: fixture.width,
          height: fixture.height,
        });

        // Importing the same file again reuses the row.
        const again = await harness(
          page,
          "importFixture",
          fixture.file,
          fixture.category,
        );

        expect(again.ref).toBe(imported.ref);
        expect(again.created).toBe(false);
        expect(await harness(page, "count", fixture.category)).toBe(1);
        expect(page.errors).toEqual([]);
      });
    }
  });
});
