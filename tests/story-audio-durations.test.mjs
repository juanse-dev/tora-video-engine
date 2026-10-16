import assert from "node:assert/strict";
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import {
  localAudioRefsKey,
  parseLocalAudioRefsKey,
  sameDurationMap,
  startAudioDurationRead,
} from "../src/web/useStoryAudioDurations.ts";
import {createMemoryAssetStore} from "./helpers/memoryAssetStore.mjs";

const audioRef = (n) => `local:audio:sha256:${n.toString(16).padStart(64, "0")}`;
const scene = (extra = {}) => ({type: "intro", pose: "formal", background: "office", text: "Hi", duration: 3, ...extra});

describe("localAudioRefsKey", () => {
  it("lists the Story's distinct local audio refs, sorted, without bundled sounds", () => {
    const story = {
      title: "T",
      music: {src: audioRef(3)},
      scenes: [scene({sfx: {src: "boom"}, voice: {src: audioRef(2)}}), scene({sfx: {src: audioRef(3)}, voice: {src: audioRef(1)}})],
    };

    assert.equal(localAudioRefsKey(story), [audioRef(1), audioRef(2), audioRef(3)].join(","));
    assert.deepEqual(parseLocalAudioRefsKey(localAudioRefsKey(story)), [audioRef(1), audioRef(2), audioRef(3)]);
  });

  it("is empty for a Story without local audio and does not depend on scene order", () => {
    assert.equal(localAudioRefsKey({title: "T", scenes: [scene({sfx: {src: "ding"}})]}), "");
    assert.deepEqual(parseLocalAudioRefsKey(""), []);

    const a = {title: "T", scenes: [scene({voice: {src: audioRef(1)}}), scene({voice: {src: audioRef(2)}})]};
    const b = {title: "T", scenes: [...a.scenes].reverse()};

    assert.equal(localAudioRefsKey(a), localAudioRefsKey(b));
  });
});

describe("sameDurationMap", () => {
  it("is entry-wise equality", () => {
    assert.equal(sameDurationMap({}, {}), true);
    assert.equal(sameDurationMap({[audioRef(1)]: 2.2}, {[audioRef(1)]: 2.2}), true);
    assert.equal(sameDurationMap({[audioRef(1)]: 2.2}, {[audioRef(1)]: 2.3}), false);
    assert.equal(sameDurationMap({[audioRef(1)]: 2.2}, {}), false);
    assert.equal(sameDurationMap({[audioRef(1)]: 2.2}, {[audioRef(2)]: 2.2}), false);
  });
});

describe("one duration map per page (AUDIO-001 final-review follow-up)", () => {
  const walk = (directory) =>
    readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);

      return statSync(path).isDirectory() ? walk(path) : [path];
    });

  it("App and Preview never build their own map: only the hook (and the interim render path) call storyAudioDurations", () => {
    const callers = walk("src/web")
      .filter((path) => /\.(ts|tsx)$/u.test(path))
      .filter((path) => /\bstoryAudioDurations\(/u.test(readFileSync(path, "utf8")))
      .map((path) => path.replaceAll("\\", "/"))
      .sort();

    assert.deepEqual(callers, ["src/web/browserRender.ts", "src/web/useStoryAudioDurations.ts"]);
  });

  it("App passes the hook's map to the Player config and to Preview", () => {
    const app = readFileSync("src/web/App.tsx", "utf8");

    assert.match(app, /const audioDurations = useStoryAudioDurations\(/u);
    assert.match(app, /getWebPlayerConfig\(activeStory, audioDurations\)/u);
    assert.match(app, /audioDurations=\{audioDurations\}/u);
  });
});

describe("startAudioDurationRead (the hook's effect, AUDIO-003 follow-up)", () => {
  const seed = (store, n, durationSeconds) => {
    store.setRaw("assets", audioRef(n), {
      label: `Sound ${n}`,
      originalFilename: `s${n}.wav`,
      createdAt: "2026-01-02T03:04:05.000Z",
    });
    store.setRaw("payloadMeta", n.toString(16).padStart(64, "0"), {
      kind: "audio",
      mimeType: "audio/wav",
      byteSize: 10,
      container: "wave",
      codec: "pcm",
      durationSeconds,
      sampleRate: 48_000,
      channels: 2,
    });
  };
  const flush = async () => {
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
  };
  /** Holds the store's first row read until `release()`. */
  const gatedStore = (store) => {
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let first = true;

    return {
      release,
      store: {
        getPayloadMeta: (digest) => store.getPayloadMeta(digest),
        getAssetRow: async (ref) => {
          if (first) {
            first = false;
            await gate;
          }

          return store.getAssetRow(ref);
        },
      },
    };
  };

  it("settles once with the durations of the Story's own refs, whichever library page they are on", async () => {
    const store = createMemoryAssetStore();

    seed(store, 1, 2.2);
    seed(store, 2, 4.5);

    const settled = [];

    startAudioDurationRead(store, [audioRef(1), audioRef(2), audioRef(9)], (map) => settled.push(map));
    await flush();
    assert.deepEqual(settled, [{[audioRef(1)]: 2.2, [audioRef(2)]: 4.5}]);
  });

  it("a refresh re-reads: cancelling the first read and starting a second shows the new library, and the late first result is discarded", async () => {
    const store = createMemoryAssetStore();

    seed(store, 1, 2.2);

    const first = gatedStore(store);
    const settled = [];
    const cancelFirst = startAudioDurationRead(first.store, [audioRef(1)], (map) => settled.push(["first", map]));

    await flush();
    assert.deepEqual(settled, []);

    // The library changes and the effect re-runs: cleanup, then a new read.
    seed(store, 1, 3.4);
    cancelFirst();
    startAudioDurationRead(store, [audioRef(1)], (map) => settled.push(["second", map]));
    await flush();
    assert.deepEqual(settled, [["second", {[audioRef(1)]: 3.4}]]);

    first.release();
    await flush();
    assert.deepEqual(settled, [["second", {[audioRef(1)]: 3.4}]]);
  });

  it("a read that fails settles with the empty map, once", async () => {
    const settled = [];
    const broken = {
      getAssetRow: async () => {
        throw new Error("the connection was closed");
      },
      getPayloadMeta: async () => ({status: "absent"}),
    };

    startAudioDurationRead(broken, [audioRef(1)], (map) => settled.push(map));
    await flush();
    assert.deepEqual(settled, [{}]);
  });

  it("a failed read that was cancelled settles nothing", async () => {
    const settled = [];
    const cancel = startAudioDurationRead(
      {
        getAssetRow: async () => {
          throw new Error("closed");
        },
        getPayloadMeta: async () => ({status: "absent"}),
      },
      [audioRef(1)],
      (map) => settled.push(map),
    );

    cancel();
    await flush();
    assert.deepEqual(settled, []);
  });

  it("no library or no local refs settles the empty map at once and reads nothing", () => {
    const store = createMemoryAssetStore();
    const settled = [];

    startAudioDurationRead(null, [audioRef(1)], (map) => settled.push(map));
    startAudioDurationRead(store, [], (map) => settled.push(map));
    assert.deepEqual(settled, [{}, {}]);
    assert.equal(store.reads.assets, 0);
  });

  it("cancelling before the result discards it", async () => {
    const store = createMemoryAssetStore();

    seed(store, 1, 2.2);

    const settled = [];
    const cancel = startAudioDurationRead(store, [audioRef(1)], (map) => settled.push(map));

    cancel();
    await flush();
    assert.deepEqual(settled, []);
  });

  it("the hook runs it as its effect, restarted when the library, the refs or the refresh token change", () => {
    const source = readFileSync("src/web/useStoryAudioDurations.ts", "utf8");

    assert.match(source, /startAudioDurationRead\(store, parseLocalAudioRefsKey\(refsKey\)/u);
    assert.match(source, /\[store, refsKey, refreshToken\]/u);
  });
});
