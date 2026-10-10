import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {buildLocalAssetRef} from "../src/localAssets/refs.ts";
import {exampleStory} from "../src/story/exampleStory.ts";
import {ASSET_LIBRARY_LOCK} from "../src/web/assetLibrary/constants.ts";
import {createLocalAssetRenderPreparation} from "../src/web/localAssetState.ts";
import {
  acquireBrowserRenderLock,
  BROWSER_FRAME_DURATION_MICROSECONDS,
  canDownloadBrowserRenderSnapshot,
  checkBrowserRenderCapability,
  cleanupRemotionOpfsUntilEmpty,
  evaluateBrowserRenderPolicy,
  materializeBrowserDownloadBlob,
  renderStoryMediaOnWeb,
  retryBrowserRenderCleanup,
  startBrowserRenderTransaction,
  WEB_RENDER_LOCK_NAME,
} from "../src/web/browserRender.ts";

import {
  createMemoryAssetStore,
  createMemoryLockManager,
} from "./helpers/memoryAssetStore.mjs";

const readyCapability = async () => ({kind: "ready"});

describe("WEB-006 browser rendering", () => {
  it("checks H.264 MP4 capability with muted video and requires web-fs", async () => {
    let seen = null;

    const capability = await checkBrowserRenderCapability({
      getLocks: () => ({query: async () => ({held: [], pending: []})}),
      canRender: async (options) => {
        seen = options;

        return {
          canRender: true,
          issues: [],
          resolvedVideoCodec: "h264",
          resolvedAudioCodec: null,
          resolvedOutputTarget: "web-fs",
        };
      },
    });

    assert.deepEqual(capability, {kind: "ready"});
    assert.deepEqual(seen, {
      container: "mp4",
      videoCodec: "h264",
      width: 1080,
      height: 1920,
      muted: true,
    });
  });

  it("rejects arraybuffer-only capability", async () => {
    const capability = await checkBrowserRenderCapability({
      getLocks: () => ({query: async () => ({held: [], pending: []})}),
      canRender: async () => ({
        canRender: true,
        issues: [],
        resolvedVideoCodec: "h264",
        resolvedAudioCodec: null,
        resolvedOutputTarget: "arraybuffer",
      }),
    });

    assert.equal(capability.kind, "unsupported");
    assert.match(capability.message, /web-fs/);
  });

  it("rejects rendering when Web Locks are unavailable", async () => {
    const capability = await checkBrowserRenderCapability({
      getLocks: () => undefined,
      canRender: async () => {
        throw new Error("must not run");
      },
    });

    assert.equal(capability.kind, "unsupported");
    assert.match(capability.message, /Web Locks/);
  });

  it("acquires the unversioned render lock and releases it explicitly", async () => {
    let request = null;
    let callbackSettled = false;

    const locks = {
      request(name, options, callback) {
        request = {name, options};

        return callback({name}).then(() => {
          callbackSettled = true;
        });
      },
    };

    const lease = await acquireBrowserRenderLock(() => locks);

    assert.equal(lease.mode, "owner");
    assert.equal(request.name, WEB_RENDER_LOCK_NAME);
    assert.deepEqual(request.options, {
      mode: "exclusive",
      ifAvailable: true,
    });
    assert.equal(callbackSettled, false);

    lease.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(callbackSettled, true);
  });

  it("reports a busy render lock without waiting in a queue", async () => {
    const locks = {
      request(_name, options, callback) {
        assert.equal(options.ifAvailable, true);
        return Promise.resolve(callback(null));
      },
    };

    const lease = await acquireBrowserRenderLock(() => locks);
    assert.deepEqual(lease, {mode: "busy"});
  });

  it("retries OPFS cleanup until the Remotion prefix is empty", async () => {
    const names = new Set([
      "__remotion_render:old:file",
      "unrelated-file",
    ]);
    let removals = 0;
    const waits = [];

    const root = {
      async *entries() {
        for (const name of [...names]) {
          yield [name, {}];
        }
      },
      async removeEntry(name) {
        removals += 1;

        if (removals === 1) {
          throw new Error("writer still closing");
        }

        names.delete(name);
      },
    };

    const result = await cleanupRemotionOpfsUntilEmpty({
      getDirectory: async () => root,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      backoffMs: [0, 25, 50],
    });

    assert.deepEqual(result, {ok: true, attempts: 2});
    assert.deepEqual(waits, [25]);
    assert.deepEqual([...names], ["unrelated-file"]);
  });

  it("keeps policy short-circuiting before metadata and serialization for 201 scenes", () => {
    const story = structuredClone(exampleStory);

    while (story.scenes.length < 201) {
      story.scenes.push(structuredClone(story.scenes[0]));
    }

    let derived = false;
    let serialized = false;
    const result = evaluateBrowserRenderPolicy(story, {
      deriveTotalFrames: () => {
        derived = true;
        throw new Error("must not derive");
      },
      serialize: () => {
        serialized = true;
        throw new Error("must not serialize");
      },
    });

    assert.equal(result.eligible, false);
    assert.equal(result.reason, "scene-count");
    assert.equal(derived, false);
    assert.equal(serialized, false);
  });

  it("suppresses download when the frozen Story no longer matches live authoring", () => {
    const snapshot = structuredClone(exampleStory);
    const same = structuredClone(exampleStory);
    const changed = structuredClone(exampleStory);
    changed.scenes[0].text = "Changed after render started";

    assert.equal(
      canDownloadBrowserRenderSnapshot(snapshot, same, false),
      true,
    );
    assert.equal(
      canDownloadBrowserRenderSnapshot(snapshot, changed, false),
      false,
    );
    assert.equal(
      canDownloadBrowserRenderSnapshot(snapshot, same, true),
      false,
    );
  });

  it("materializes an independent download Blob with the same bytes and media type", async () => {
    const source = new Blob(["browser-video"], {type: "video/mp4"});
    const snapshot = await materializeBrowserDownloadBlob(source);

    assert.notEqual(snapshot, source);
    assert.equal(snapshot.type, "video/mp4");
    assert.equal(await snapshot.text(), "browser-video");
  });

  it("passes the shared composition and exact video-only settings to Remotion", async () => {
    let seen = null;
    const controller = new AbortController();

    const StubComposition = () => null;

    await renderStoryMediaOnWeb(exampleStory, {
      signal: controller.signal,
      licenseKey: "public-test-key",
      component: StubComposition,
      render: async (options) => {
        seen = options;

        return {
          getBlob: async () => new Blob(["video"]),
          internalState: {},
        };
      },
    });

    assert.equal(seen.container, "mp4");
    assert.equal(seen.videoCodec, "h264");
    assert.equal(seen.muted, true);
    assert.equal(seen.outputTarget, "web-fs");
    assert.equal(seen.allowHtmlInCanvas, false);
    assert.equal(typeof seen.onFrame, "function");
    assert.equal(BROWSER_FRAME_DURATION_MICROSECONDS, 33_333);
    assert.equal(seen.licenseKey, "public-test-key");
    assert.equal(seen.inputProps.story, exampleStory);
    assert.equal(seen.composition.id, "ToraVideo");
    assert.equal(seen.composition.width, 1080);
    assert.equal(seen.composition.height, 1920);
    assert.equal(seen.composition.fps, 30);
    assert.equal(seen.composition.durationInFrames, 360);
  });

  it("consumes the public Blob before cleanup and holds the lock through both", async () => {
    const events = [];
    const blob = new Blob(["immutable-public-snapshot"]);
    const lease = {
      mode: "owner",
      release: () => events.push("release"),
    };

    const outcome = await startBrowserRenderTransaction(exampleStory, {
      signal: new AbortController().signal,
      checkCapability: readyCapability,
      acquireLock: async () => lease,
      cleanup: async () => {
        events.push("cleanup");
        return {ok: true, attempts: 1};
      },
      renderStory: async () => {
        events.push("render");

        return {
          getBlob: async () => {
            events.push("getBlob");
            return blob;
          },
          internalState: {},
        };
      },
      materializeBlob: async (received) => {
        events.push("materialize");
        assert.equal(received, blob);

        return new Blob([await received.arrayBuffer()], {
          type: "video/mp4",
        });
      },
      consumeBlob: async (received) => {
        events.push("consume");
        assert.notEqual(received, blob);
        assert.equal(await received.text(), "immutable-public-snapshot");
      },
    });

    assert.deepEqual(events, [
      "cleanup",
      "render",
      "getBlob",
      "materialize",
      "consume",
      "cleanup",
      "release",
    ]);
    assert.equal(outcome.kind, "success");
    assert.notEqual(outcome.blob, blob);
    assert.equal(await outcome.blob.text(), "immutable-public-snapshot");
    assert.equal(outcome.consumed, true);
  });

  it("treats cancellation during getBlob as cancelled", async () => {
    const controller = new AbortController();
    let releaseBlob = null;
    let released = false;
    const blobReady = new Promise((resolve) => {
      releaseBlob = resolve;
    });

    const transaction = startBrowserRenderTransaction(exampleStory, {
      signal: controller.signal,
      checkCapability: readyCapability,
      acquireLock: async () => ({
        mode: "owner",
        release: () => {
          released = true;
        },
      }),
      cleanup: async () => ({ok: true, attempts: 1}),
      renderStory: async () => ({
        getBlob: async () => {
          await blobReady;
          return new Blob(["late-blob"]);
        },
        internalState: {},
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    releaseBlob();

    const outcome = await transaction;

    assert.deepEqual(outcome, {kind: "cancelled"});
    assert.equal(released, true);
  });

  it("treats cancellation during post-render cleanup as cancelled", async () => {
    const controller = new AbortController();
    let cleanupCall = 0;
    let finishPostCleanup = null;
    let signalPostCleanupStarted = null;
    let released = false;
    const postCleanupStarted = new Promise((resolve) => {
      signalPostCleanupStarted = resolve;
    });
    const postCleanupGate = new Promise((resolve) => {
      finishPostCleanup = resolve;
    });

    const transaction = startBrowserRenderTransaction(exampleStory, {
      signal: controller.signal,
      checkCapability: readyCapability,
      acquireLock: async () => ({
        mode: "owner",
        release: () => {
          released = true;
        },
      }),
      cleanup: async () => {
        cleanupCall += 1;

        if (cleanupCall === 1) {
          return {ok: true, attempts: 1};
        }

        signalPostCleanupStarted();
        await postCleanupGate;
        return {ok: true, attempts: 1};
      },
      renderStory: async () => ({
        getBlob: async () => new Blob(["completed-blob"]),
        internalState: {},
      }),
    });

    await postCleanupStarted;
    controller.abort();
    finishPostCleanup();

    const outcome = await transaction;

    assert.deepEqual(outcome, {kind: "cancelled"});
    assert.equal(released, true);
  });

  it("does not start a render when preflight cleanup remains blocked", async () => {
    let released = false;
    let rendered = false;
    const blocked = await startBrowserRenderTransaction(exampleStory, {
      signal: new AbortController().signal,
      checkCapability: readyCapability,
      acquireLock: async () => ({
        mode: "owner",
        release: () => {
          released = true;
        },
      }),
      cleanup: async () => ({
        ok: false,
        attempts: 9,
        error: new Error("still busy"),
        remaining: ["__remotion_render:stale"],
      }),
      renderStory: async () => {
        rendered = true;
        throw new Error("must not render");
      },
    });

    assert.equal(blocked.kind, "cleanup-blocked");
    assert.equal(blocked.stage, "pre");
    assert.equal(rendered, false);
    assert.equal(released, false);

    const retried = await retryBrowserRenderCleanup(
      blocked,
      async () => ({ok: true, attempts: 1}),
    );

    assert.deepEqual(retried, {kind: "pre-cleanup-cleared"});
    assert.equal(released, true);
  });

  it("retains the public Blob while post-render cleanup is blocked", async () => {
    const blob = new Blob(["public-remotion-blob"]);
    const snapshot = new Blob(["materialized-download-blob"], {
      type: "video/mp4",
    });
    let cleanupCall = 0;
    let released = false;

    const blocked = await startBrowserRenderTransaction(exampleStory, {
      signal: new AbortController().signal,
      checkCapability: readyCapability,
      acquireLock: async () => ({
        mode: "owner",
        release: () => {
          released = true;
        },
      }),
      cleanup: async () => {
        cleanupCall += 1;

        if (cleanupCall === 1) {
          return {ok: true, attempts: 1};
        }

        return {
          ok: false,
          attempts: 9,
          error: new Error("writer closing"),
          remaining: ["__remotion_render:current"],
        };
      },
      renderStory: async () => ({
        getBlob: async () => blob,
        internalState: {},
      }),
      materializeBlob: async (received) => {
        assert.equal(received, blob);
        return snapshot;
      },
    });

    assert.equal(blocked.kind, "cleanup-blocked");
    assert.equal(blocked.stage, "post");
    assert.equal(blocked.pending.kind, "success");
    assert.equal(blocked.pending.blob, snapshot);
    assert.equal(blocked.pending.consumed, false);
    assert.equal(released, false);

    const retried = await retryBrowserRenderCleanup(
      blocked,
      async () => ({ok: true, attempts: 2}),
    );

    assert.equal(retried.kind, "success");
    assert.equal(retried.blob, snapshot);
    assert.equal(retried.consumed, false);
    assert.equal(released, true);
  });

  it("cancels before rendering if the request is aborted during preflight", async () => {
    const controller = new AbortController();
    let released = false;
    let rendered = false;

    const outcome = await startBrowserRenderTransaction(exampleStory, {
      signal: controller.signal,
      checkCapability: readyCapability,
      acquireLock: async () => ({
        mode: "owner",
        release: () => {
          released = true;
        },
      }),
      cleanup: async () => {
        controller.abort();
        return {ok: true, attempts: 1};
      },
      renderStory: async () => {
        rendered = true;
        throw new Error("must not render");
      },
    });

    assert.deepEqual(outcome, {kind: "cancelled"});
    assert.equal(rendered, false);
    assert.equal(released, true);
  });
});

// --- ASSET-004: local asset preparation inside the transaction ---------------

const LOCAL_DIGEST = "ab".repeat(32);
const LOCAL_POSE = buildLocalAssetRef("pose", LOCAL_DIGEST);
const LOCAL_META = {
  mimeType: "image/png",
  byteSize: 10,
  width: 4,
  height: 3,
};

const lockedSources = Object.freeze({
  [LOCAL_POSE]: {kind: "url", url: "blob:test/pose"},
});

/** A transaction option set whose render succeeds; callers override pieces. */
const baseOptions = (events, overrides = {}) => ({
  signal: new AbortController().signal,
  checkCapability: readyCapability,
  acquireLock: async () => {
    events.push("acquire-lock");

    return {mode: "owner", release: () => events.push("lease-release")};
  },
  cleanup: async () => {
    events.push("cleanup");

    return {ok: true, attempts: 1};
  },
  renderStory: async (_story, options) => {
    events.push("render");
    events.sources = options.localAssetSources;

    return {getBlob: async () => new Blob(["v"]), internalState: {}};
  },
  ...overrides,
});

const okPreparation = (events, sources = lockedSources) => async () => {
  events.push("prepare");

  return {
    ok: true,
    localAssetSources: sources,
    release: () => events.push("prepare-release"),
  };
};

const countOf = (events, name) =>
  events.filter((event) => event === name).length;

const preparedFixture = () => {
  const store = createMemoryAssetStore();

  store.setRaw("assets", LOCAL_POSE, {
    label: "Pose",
    originalFilename: "pose.png",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  store.setRaw("payloadMeta", LOCAL_DIGEST, {...LOCAL_META});

  const usage = {
    ref: LOCAL_POSE,
    category: "pose",
    digest: LOCAL_DIGEST,
    sceneIndexes: [0],
  };
  const resolved = {
    kind: "resolved",
    refs: [{usage, status: "ready", detail: null}],
    verified: new Map([[LOCAL_DIGEST, {digest: LOCAL_DIGEST, ...LOCAL_META}]]),
    blobs: new Map([[LOCAL_DIGEST, new Blob(["pose"])]]),
    allReady: true,
    failureMessage: null,
  };

  return {store, resolved};
};

describe("ASSET-004 render transaction with local assets", () => {
  it("passes localAssetSources as both defaultProps and inputProps", async () => {
    let seen = null;

    await renderStoryMediaOnWeb(exampleStory, {
      signal: new AbortController().signal,
      component: () => null,
      localAssetSources: lockedSources,
      render: async (options) => {
        seen = options;

        return {getBlob: async () => new Blob(["v"]), internalState: {}};
      },
    });

    assert.deepEqual(seen.composition.defaultProps, {
      story: exampleStory,
      localAssetSources: lockedSources,
    });
    assert.deepEqual(seen.inputProps, {
      story: exampleStory,
      localAssetSources: lockedSources,
    });
    assert.equal(seen.inputProps.localAssetSources, lockedSources);
  });

  it("refuses to render a local ref that has no url or static source (INV-5)", async () => {
    const localStory = {
      ...exampleStory,
      scenes: exampleStory.scenes.map((scene, index) =>
        index === 0 ? {...scene, pose: LOCAL_POSE} : scene,
      ),
    };
    let rendered = 0;
    const attempt = (localAssetSources) =>
      renderStoryMediaOnWeb(localStory, {
        signal: new AbortController().signal,
        component: () => null,
        localAssetSources,
        render: async () => {
          rendered += 1;

          return {getBlob: async () => new Blob(["v"]), internalState: {}};
        },
      });

    await assert.rejects(attempt(undefined), /local asset/i);
    await assert.rejects(attempt({}), /local asset/i);
    await assert.rejects(
      attempt({[LOCAL_POSE]: {kind: "pending"}}),
      /local asset/i,
    );
    assert.equal(rendered, 0);

    await attempt(lockedSources);
    await attempt({[LOCAL_POSE]: {kind: "static", path: "__local-assets/pose/x.png"}});
    assert.equal(rendered, 2);
  });

  it("runs prepareLocalAssets after the lock and before the first cleanup, then renders with its sources", async () => {
    const events = [];
    const received = [];

    const outcome = await startBrowserRenderTransaction(
      exampleStory,
      baseOptions(events, {
        prepareLocalAssets: async (signal) => {
          received.push(signal);

          return okPreparation(events)();
        },
      }),
    );

    assert.equal(outcome.kind, "success");
    assert.deepEqual(events.slice(0, 4), [
      "acquire-lock",
      "prepare",
      "cleanup",
      "render",
    ]);
    assert.equal(events.sources, lockedSources);
    assert.equal(received.length, 1);
    assert.ok(received[0] instanceof AbortSignal);
  });

  it("renders bundled-only Stories without local sources", async () => {
    const events = [];

    await startBrowserRenderTransaction(exampleStory, baseOptions(events));

    assert.equal(events.sources, undefined);
  });

  it("returns assets-changed without touching OPFS when preparation says ok:false", async () => {
    const events = [];

    const outcome = await startBrowserRenderTransaction(
      exampleStory,
      baseOptions(events, {
        prepareLocalAssets: async () => ({
          ok: false,
          message: "Local assets changed while preparing the render. Try again.",
        }),
      }),
    );

    assert.deepEqual(outcome, {
      kind: "assets-changed",
      message: "Local assets changed while preparing the render. Try again.",
    });
    assert.deepEqual(events, ["acquire-lock", "lease-release"]);
  });

  it("cancels, releasing the render lease, when aborted while the shared asset lock is still waiting", async () => {
    const events = [];
    const {store, resolved} = preparedFixture();
    const locks = createMemoryLockManager();
    const controller = new AbortController();
    let releaseExclusive;
    const holder = locks.request(
      ASSET_LIBRARY_LOCK,
      {mode: "exclusive"},
      () => new Promise((resolve) => (releaseExclusive = resolve)),
    );
    const prepare = createLocalAssetRenderPreparation({
      resolved,
      store,
      locks,
      pool: {acquire: () => "blob:never", release() {}},
    });
    const pending = startBrowserRenderTransaction(
      exampleStory,
      baseOptions(events, {
        signal: controller.signal,
        prepareLocalAssets: prepare,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(
      locks.requests.map((request) => [request.mode, request.granted]),
      [
        ["exclusive", true],
        ["shared", false],
      ],
    );
    controller.abort();

    assert.deepEqual(await pending, {kind: "cancelled"});
    assert.deepEqual(events, ["acquire-lock", "lease-release"]);

    releaseExclusive();
    await holder;
  });

  it("reports failure and releases the lease when preparation rejects, and the next attempt is not busy", async () => {
    const events = [];
    let held = false;
    const fakeLocks = {
      request(name, options, callback) {
        if (held && options.ifAvailable) {
          return Promise.resolve(callback(null));
        }

        held = true;

        return Promise.resolve(callback({name})).finally(() => {
          held = false;
        });
      },
    };
    const acquire = () => acquireBrowserRenderLock(() => fakeLocks);

    const failed = await startBrowserRenderTransaction(exampleStory, {
      ...baseOptions(events),
      acquireLock: acquire,
      prepareLocalAssets: async () => {
        throw new Error("indexeddb read failed");
      },
    });

    assert.equal(failed.kind, "failure");
    assert.equal(failed.error.message, "indexeddb read failed");
    assert.equal(countOf(events, "cleanup"), 0);
    assert.equal(countOf(events, "render"), 0);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = await startBrowserRenderTransaction(exampleStory, {
      ...baseOptions(events),
      acquireLock: acquire,
    });

    assert.equal(second.kind, "success");
  });

  it("reports cancelled when preparation rejects after abort", async () => {
    const events = [];
    const controller = new AbortController();

    const outcome = await startBrowserRenderTransaction(
      exampleStory,
      baseOptions(events, {
        signal: controller.signal,
        prepareLocalAssets: async () => {
          controller.abort();
          throw new DOMException("Aborted", "AbortError");
        },
      }),
    );

    assert.deepEqual(outcome, {kind: "cancelled"});
    assert.deepEqual(events, ["acquire-lock", "lease-release"]);
  });

  describe("release() is called exactly once on every path after a successful preparation", () => {
    it("post-cleanup success (after the post cleanup)", async () => {
      const events = [];
      const outcome = await startBrowserRenderTransaction(
        exampleStory,
        baseOptions(events, {prepareLocalAssets: okPreparation(events)}),
      );

      assert.equal(outcome.kind, "success");
      assert.equal(countOf(events, "prepare-release"), 1);
      assert.ok(
        events.lastIndexOf("cleanup") < events.indexOf("prepare-release"),
      );
    });

    it("render failure", async () => {
      const events = [];
      const outcome = await startBrowserRenderTransaction(
        exampleStory,
        baseOptions(events, {
          prepareLocalAssets: okPreparation(events),
          renderStory: async () => {
            throw new Error("encode failed");
          },
        }),
      );

      assert.equal(outcome.kind, "failure");
      assert.equal(countOf(events, "prepare-release"), 1);
    });

    it("cancel during rendering", async () => {
      const events = [];
      const controller = new AbortController();
      const outcome = await startBrowserRenderTransaction(
        exampleStory,
        baseOptions(events, {
          signal: controller.signal,
          prepareLocalAssets: okPreparation(events),
          renderStory: async () => {
            controller.abort();
            throw new Error("aborted");
          },
        }),
      );

      assert.deepEqual(outcome, {kind: "cancelled"});
      assert.equal(countOf(events, "prepare-release"), 1);
    });

    it("post-cleanup cleanup-blocked", async () => {
      const events = [];
      let calls = 0;
      const outcome = await startBrowserRenderTransaction(
        exampleStory,
        baseOptions(events, {
          prepareLocalAssets: okPreparation(events),
          cleanup: async () => {
            calls += 1;

            return calls === 1
              ? {ok: true, attempts: 1}
              : {
                  ok: false,
                  attempts: 9,
                  error: null,
                  remaining: ["__remotion_render:x"],
                };
          },
        }),
      );

      assert.equal(outcome.kind, "cleanup-blocked");
      assert.equal(outcome.stage, "post");
      assert.equal(countOf(events, "prepare-release"), 1);
    });

    it("pre-cleanup cleanup-blocked (no render)", async () => {
      const events = [];
      const outcome = await startBrowserRenderTransaction(
        exampleStory,
        baseOptions(events, {
          prepareLocalAssets: okPreparation(events),
          cleanup: async () => ({
            ok: false,
            attempts: 9,
            error: null,
            remaining: ["__remotion_render:x"],
          }),
        }),
      );

      assert.equal(outcome.kind, "cleanup-blocked");
      assert.equal(outcome.stage, "pre");
      assert.equal(countOf(events, "render"), 0);
      assert.equal(countOf(events, "prepare-release"), 1);
    });

    it("abort between preparation and pre-cleanup", async () => {
      const events = [];
      const controller = new AbortController();
      const outcome = await startBrowserRenderTransaction(
        exampleStory,
        baseOptions(events, {
          signal: controller.signal,
          prepareLocalAssets: async () => {
            controller.abort();

            return okPreparation(events)();
          },
        }),
      );

      assert.deepEqual(outcome, {kind: "cancelled"});
      assert.equal(countOf(events, "render"), 0);
      assert.equal(countOf(events, "prepare-release"), 1);
    });
  });

  it("orders render lock, shared asset lock, row re-reads, frozen map, lock release, then render", async () => {
    const events = [];
    const {store, resolved} = preparedFixture();
    const memoryLocks = createMemoryLockManager();
    const locks = {
      request(name, options, callback) {
        events.push(`asset-lock-request:${options.mode}`);

        return memoryLocks
          .request(name, options, callback)
          .finally(() => events.push("asset-lock-released"));
      },
    };
    const recordingStore = new Proxy(store, {
      get(target, property) {
        if (property === "getAssetRow") {
          return async (ref) => {
            events.push("row-read");

            return target.getAssetRow(ref);
          };
        }

        const value = target[property];

        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const prepare = createLocalAssetRenderPreparation({
      resolved,
      store: recordingStore,
      locks,
      pool: {acquire: () => "blob:test/pose", release() {}},
    });

    const outcome = await startBrowserRenderTransaction(
      exampleStory,
      baseOptions(events, {
        acquireLock: async () => {
          events.push("render-lock-granted");

          return {mode: "owner", release: () => events.push("lease-release")};
        },
        prepareLocalAssets: async (signal) => {
          const result = await prepare(signal);

          events.push(
            `frozen:${result.ok && Object.isFrozen(result.localAssetSources)}`,
          );

          return result;
        },
      }),
    );

    assert.equal(outcome.kind, "success");
    assert.deepEqual(events.slice(0, 7), [
      "render-lock-granted",
      "asset-lock-request:shared",
      "row-read",
      "asset-lock-released",
      "frozen:true",
      "cleanup",
      "render",
    ]);
  });
});
