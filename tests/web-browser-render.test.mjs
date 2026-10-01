import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {exampleStory} from "../src/story/exampleStory.ts";
import {
  acquireBrowserRenderLock,
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
