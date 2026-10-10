import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {createLocalAssetPageController} from "../src/web/localAssetPageController.ts";

const digestOf = (n) => n.toString(16).padStart(64, "0");
const refOf = (category, n) => `local:${category}:sha256:${digestOf(n)}`;
const presentRow = (n) => ({
  status: "present",
  value: {
    label: `Asset ${n}`,
    originalFilename: `a${n}.png`,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
});

const createFakeStore = (category, numbers, {corrupt = []} = {}) => {
  const rows = new Map(
    numbers.map((n) => [
      refOf(category, n),
      corrupt.includes(n) ? {status: "corrupt", reason: "bad"} : presentRow(n),
    ]),
  );
  const sorted = () => [...rows.keys()].sort();

  return {
    rows,
    async listAssets(_category, cursor, limit) {
      const keys = sorted();
      const picked =
        cursor.before !== undefined
          ? keys.filter((key) => key < cursor.before).slice(-limit)
          : keys
              .filter((key) => cursor.after === undefined || key > cursor.after)
              .slice(0, limit);

      return picked.map((ref) => ({ref, row: rows.get(ref)}));
    },
    async countAssets() {
      return rows.size;
    },
    async getAssetRow(ref) {
      return rows.get(ref) ?? {status: "absent"};
    },
  };
};

const createHarness = (store, options = {}) => {
  const created = [];
  const revoked = [];
  const thumbnailLoads = [];
  const controller = createLocalAssetPageController({
    store,
    category: "pose",
    loadThumbnail:
      options.loadThumbnail ??
      (async (digest) => {
        thumbnailLoads.push(digest);

        return {ok: true, blob: new Blob([digest])};
      }),
    createUrl: (blob) => {
      const url = `blob:test/${created.length}`;

      created.push({url, blob});

      return url;
    },
    revokeUrl: (url) => revoked.push(url),
  });

  return {controller, created, revoked, thumbnailLoads};
};

const live = (created, revoked) =>
  created.map((entry) => entry.url).filter((url) => !revoked.includes(url));

const numbers = (count) => Array.from({length: count}, (_, i) => i + 1);

describe("ASSET-003 local asset page controller", () => {
  it("loads the first page of 50 with the total, and thumbnails only for the visible page", async () => {
    const store = createFakeStore("pose", numbers(120));
    const {controller, created, revoked, thumbnailLoads} =
      createHarness(store);

    await controller.sync(null);

    const snapshot = controller.getSnapshot();

    assert.equal(snapshot.entries.length, 50);
    assert.equal(snapshot.total, 120);
    assert.equal(snapshot.hasPrevious, false);
    assert.equal(snapshot.hasNext, true);
    assert.equal(snapshot.loading, false);
    assert.equal(thumbnailLoads.length, 50);
    assert.equal(created.length, 50);
    assert.ok(snapshot.entries.every((entry) => entry.thumbnailUrl !== null));
    assert.deepEqual(revoked, []);
  });

  it("pages forward and back, revoking the previous page URLs", async () => {
    const store = createFakeStore("pose", numbers(120));
    const {controller, created, revoked} = createHarness(store);

    await controller.sync(null);

    const firstRefs = controller
      .getSnapshot()
      .entries.map((entry) => entry.ref);

    await controller.next();

    const second = controller.getSnapshot();

    assert.equal(second.entries.length, 50);
    assert.equal(second.hasPrevious, true);
    assert.equal(second.hasNext, true);
    assert.ok(second.entries.every((entry) => !firstRefs.includes(entry.ref)));
    assert.equal(live(created, revoked).length, 50);
    assert.equal(revoked.length, 50);

    await controller.next();
    assert.equal(controller.getSnapshot().entries.length, 20);
    assert.equal(controller.getSnapshot().hasNext, false);

    await controller.previous();
    await controller.previous();

    const back = controller.getSnapshot();

    assert.deepEqual(
      back.entries.map((entry) => entry.ref),
      firstRefs,
    );
    assert.equal(back.hasPrevious, false);
    assert.equal(live(created, revoked).length, 50);
  });

  it("does nothing on next at the last page and previous at the first", async () => {
    const store = createFakeStore("pose", [1, 2, 3]);
    const {controller} = createHarness(store);

    await controller.sync(null);
    await controller.next();
    await controller.previous();

    assert.equal(controller.getSnapshot().entries.length, 3);
  });

  it("ignores next() while a load is pending, so a double click advances one page", async () => {
    const store = createFakeStore("pose", numbers(120));
    const {controller} = createHarness(store);

    await controller.sync(null);

    const firstRefs = controller
      .getSnapshot()
      .entries.map((entry) => entry.ref);
    const first = controller.next();
    const second = controller.next(); // before the first load commits

    await Promise.all([first, second]);
    assert.equal(controller.getSnapshot().entries[0].ref, refOf("pose", 51));

    await controller.previous();

    const back = controller.getSnapshot();

    assert.deepEqual(
      back.entries.map((entry) => entry.ref),
      firstRefs,
    );
    assert.equal(back.hasPrevious, false);
  });

  it("ignores previous() while a load is pending", async () => {
    const store = createFakeStore("pose", numbers(120));
    const {controller} = createHarness(store);

    await controller.sync(null);
    await controller.next();
    await controller.next();
    assert.equal(controller.getSnapshot().entries[0].ref, refOf("pose", 101));

    const first = controller.previous();
    const second = controller.previous(); // before the first load commits

    await Promise.all([first, second]);
    assert.equal(controller.getSnapshot().entries[0].ref, refOf("pose", 51));
    assert.equal(controller.getSnapshot().hasPrevious, true);
  });

  it("reports a load failure, keeps the previous page, and recovers on refresh", async () => {
    const store = createFakeStore("pose", numbers(3));
    const {controller} = createHarness(store);

    await controller.sync(null);
    assert.equal(controller.getSnapshot().error, null);

    const list = store.listAssets;

    store.listAssets = async () => {
      throw new Error("db closed");
    };
    await controller.refresh();

    const failed = controller.getSnapshot();

    assert.equal(failed.error, "Could not load My assets.");
    assert.equal(failed.loading, false);
    assert.equal(failed.entries.length, 3);
    assert.equal(failed.total, 3);

    store.listAssets = list;
    await controller.refresh();
    assert.equal(controller.getSnapshot().error, null);
    assert.equal(controller.getSnapshot().entries.length, 3);
  });

  it("reports a first-load failure with an empty page", async () => {
    const store = createFakeStore("pose", numbers(3));

    store.countAssets = async () => {
      throw new Error("db closed");
    };

    const {controller} = createHarness(store);

    await controller.sync(null);

    const snapshot = controller.getSnapshot();

    assert.equal(snapshot.error, "Could not load My assets.");
    assert.deepEqual(snapshot.entries, []);
    assert.equal(snapshot.loading, false);
  });

  it("a failed next() keeps the page and the cursor, so Next can be retried", async () => {
    const store = createFakeStore("pose", numbers(120));
    const {controller} = createHarness(store);

    await controller.sync(null);

    const list = store.listAssets;

    store.listAssets = async () => {
      throw new Error("db closed");
    };
    await controller.next();
    assert.equal(controller.getSnapshot().error, "Could not load My assets.");
    assert.equal(controller.getSnapshot().entries[0].ref, refOf("pose", 1));
    assert.equal(controller.getSnapshot().hasPrevious, false);

    store.listAssets = list;
    await controller.next();
    assert.equal(controller.getSnapshot().error, null);
    assert.equal(controller.getSnapshot().entries[0].ref, refOf("pose", 51));
    await controller.previous();
    assert.equal(controller.getSnapshot().entries[0].ref, refOf("pose", 1));
  });

  it("refresh keeps the URLs of digests that stay visible", async () => {
    const store = createFakeStore("pose", [1, 2, 3]);
    const {controller, created, revoked, thumbnailLoads} =
      createHarness(store);

    await controller.sync(null);
    store.rows.set(refOf("pose", 4), presentRow(4));
    await controller.refresh();

    assert.equal(controller.getSnapshot().entries.length, 4);
    assert.equal(controller.getSnapshot().total, 4);
    assert.equal(created.length, 4); // only the new digest needed a URL
    assert.equal(thumbnailLoads.length, 4);
    assert.deepEqual(revoked, []);
  });

  it("steps back one page when the current page became empty", async () => {
    const store = createFakeStore("pose", numbers(60));
    const {controller} = createHarness(store);

    await controller.sync(null);
    await controller.next();
    assert.equal(controller.getSnapshot().entries.length, 10);

    for (let n = 51; n <= 60; n += 1) {
      store.rows.delete(refOf("pose", n));
    }

    await controller.refresh();

    const snapshot = controller.getSnapshot();

    assert.equal(snapshot.entries.length, 50);
    assert.equal(snapshot.total, 50);
    assert.equal(snapshot.hasPrevious, false);
    assert.equal(snapshot.hasNext, false);
  });

  it("does not load thumbnails for corrupt rows", async () => {
    const store = createFakeStore("pose", [1, 2, 3], {corrupt: [2]});
    const {controller, thumbnailLoads} = createHarness(store);

    await controller.sync(null);

    const entries = controller.getSnapshot().entries;

    assert.equal(entries[1].row.status, "corrupt");
    assert.equal(entries[1].thumbnailUrl, null);
    assert.deepEqual(thumbnailLoads, [digestOf(1), digestOf(3)]);
  });

  it("keeps a null thumbnail when loading it fails", async () => {
    const store = createFakeStore("pose", [1, 2]);
    const {controller, created} = createHarness(store, {
      loadThumbnail: async (digest) =>
        digest === digestOf(1)
          ? {ok: false}
          : {ok: true, blob: new Blob(["x"])},
    });

    await controller.sync(null);

    const entries = controller.getSnapshot().entries;

    assert.equal(entries[0].thumbnailUrl, null);
    assert.notEqual(entries[1].thumbnailUrl, null);
    assert.equal(created.length, 1);
  });

  it("revokes every URL on dispose and ignores later calls", async () => {
    const store = createFakeStore("pose", [1, 2, 3]);
    const {controller, created, revoked} = createHarness(store);

    await controller.sync(null);
    controller.dispose();
    assert.equal(revoked.length, 3);
    assert.deepEqual(live(created, revoked), []);

    await controller.refresh();
    assert.equal(created.length, 3);
  });

  it("a stale load never leaves a URL behind", async () => {
    const store = createFakeStore("pose", [1, 2]);
    const gates = [];
    const {controller, created, revoked} = createHarness(store, {
      loadThumbnail: (digest) =>
        new Promise((resolve) => {
          gates.push(() => resolve({ok: true, blob: new Blob([digest])}));
        }),
    });
    const first = controller.sync(null);

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(gates.length, 2);

    const second = controller.refresh(); // supersedes the first

    gates.splice(0).forEach((release) => release()); // first thumbnails resolve
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    gates.splice(0).forEach((release) => release()); // second thumbnails resolve
    await second;

    assert.equal(live(created, revoked).length, 2);
    assert.equal(created.length, 2);
  });

  it("subscribers see snapshots and can unsubscribe", async () => {
    const store = createFakeStore("pose", [1]);
    const {controller} = createHarness(store);
    const seen = [];
    const unsubscribe = controller.subscribe((snapshot) =>
      seen.push(snapshot.loading),
    );

    await controller.sync(null);
    assert.ok(seen.length >= 2);
    assert.equal(seen[seen.length - 1], false);

    unsubscribe();

    const count = seen.length;

    await controller.refresh();
    assert.equal(seen.length, count);
  });

  describe("pinned (current selection) ref", () => {
    it("loads a ref that is not on the visible page", async () => {
      const store = createFakeStore("pose", numbers(120));
      const {controller} = createHarness(store);
      const pinnedRef = refOf("pose", 120);

      await controller.sync(pinnedRef);

      const {pinned, entries} = controller.getSnapshot();

      assert.equal(pinned.kind, "present");
      assert.equal(pinned.entry.ref, pinnedRef);
      assert.ok(pinned.entry.thumbnailUrl !== null);
      assert.ok(!entries.some((entry) => entry.ref === pinnedRef));
    });

    it("shares the thumbnail URL when the pinned ref is also on the page", async () => {
      const store = createFakeStore("pose", [1, 2, 3]);
      const {controller, created} = createHarness(store);

      await controller.sync(refOf("pose", 2));

      const {pinned, entries} = controller.getSnapshot();

      assert.equal(created.length, 3);
      assert.equal(pinned.entry.thumbnailUrl, entries[1].thumbnailUrl);
    });

    it("reports a ref without a row as missing, and none without a pin", async () => {
      const store = createFakeStore("pose", [1]);
      const {controller} = createHarness(store);

      await controller.sync(null);
      assert.deepEqual(controller.getSnapshot().pinned, {kind: "none"});

      await controller.sync(refOf("pose", 99));
      assert.deepEqual(controller.getSnapshot().pinned, {kind: "missing"});
    });

    it("reports a corrupt pinned row as present with the corrupt row and no thumbnail", async () => {
      const store = createFakeStore("pose", [1], {corrupt: [1]});
      const {controller, thumbnailLoads} = createHarness(store);

      await controller.sync(refOf("pose", 1));

      const {pinned} = controller.getSnapshot();

      assert.equal(pinned.kind, "present");
      assert.equal(pinned.entry.row.status, "corrupt");
      assert.equal(pinned.entry.thumbnailUrl, null);
      assert.deepEqual(thumbnailLoads, []);
    });

    it("names the pinned ref the state describes and shows loading for a newly pinned ref", async () => {
      const store = createFakeStore("pose", [1, 2]);
      const {controller} = createHarness(store);
      const seen = [];

      controller.subscribe((snapshot) =>
        seen.push({pinnedFor: snapshot.pinnedFor, kind: snapshot.pinned.kind}),
      );
      await controller.sync(refOf("pose", 1));
      assert.equal(controller.getSnapshot().pinnedFor, refOf("pose", 1));
      seen.length = 0;

      await controller.sync(refOf("pose", 2));
      // The first publish of the load already describes the new ref as loading.
      assert.deepEqual(seen[0], {pinnedFor: refOf("pose", 2), kind: "loading"});
      assert.equal(controller.getSnapshot().pinnedFor, refOf("pose", 2));
      assert.equal(controller.getSnapshot().pinned.kind, "present");
    });

    it("a failed load of a newly pinned ref ends in the error state, never stuck loading", async () => {
      const store = createFakeStore("pose", [1, 2]);
      const {controller} = createHarness(store);

      await controller.sync(refOf("pose", 1));
      store.getAssetRow = async () => {
        throw new Error("db closed");
      };
      await controller.sync(refOf("pose", 2));

      const snapshot = controller.getSnapshot();

      assert.equal(snapshot.error, "Could not load My assets.");
      assert.equal(snapshot.loading, false);
      assert.equal(snapshot.pinnedFor, refOf("pose", 2));
      assert.deepEqual(snapshot.pinned, {kind: "error"});
    });

    it("keeps an already loaded pin when a later refresh fails, and recovers on retry", async () => {
      const store = createFakeStore("pose", [1]);
      const {controller} = createHarness(store);
      const getAssetRow = store.getAssetRow;

      await controller.sync(refOf("pose", 1));
      store.getAssetRow = async () => {
        throw new Error("db closed");
      };
      await controller.refresh();
      assert.equal(controller.getSnapshot().pinned.kind, "present");

      store.getAssetRow = async () => {
        throw new Error("db closed");
      };
      await controller.sync(refOf("pose", 2));
      assert.deepEqual(controller.getSnapshot().pinned, {kind: "error"});

      store.getAssetRow = getAssetRow;
      await controller.refresh();
      assert.deepEqual(controller.getSnapshot().pinned, {kind: "missing"});
      assert.equal(controller.getSnapshot().error, null);
    });
  });

  it("is not loaded until the first load settles", async () => {
    const store = createFakeStore("pose", [1]);
    const {controller} = createHarness(store);

    assert.equal(controller.getSnapshot().loaded, false);

    const pending = controller.sync(null);

    assert.equal(controller.getSnapshot().loaded, false);
    await pending;
    assert.equal(controller.getSnapshot().loaded, true);
  });

  it("a failed first load stays not loaded", async () => {
    const store = createFakeStore("pose", [1]);

    store.countAssets = async () => {
      throw new Error("db closed");
    };

    const {controller} = createHarness(store);

    await controller.sync(null);
    assert.equal(controller.getSnapshot().loaded, false);
  });
});
