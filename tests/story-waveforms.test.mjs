import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {describe, it} from "node:test";
import {
  mergeWaveforms,
  readStoryWaveforms,
  sameWaveforms,
  startWaveformRead,
} from "../src/web/audio/storyWaveforms.ts";
import {createMemoryAssetStore} from "./helpers/memoryAssetStore.mjs";

const digestOf = (n) => n.toString(16).padStart(64, "0");
const audioRef = (n) => `local:audio:sha256:${digestOf(n)}`;
const peaksOf = (...values) => ({peaksPerSecond: 50, peaks: Uint8Array.from(values)});
const flush = async () => {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
};

describe("readStoryWaveforms", () => {
  it("returns the stored peaks of exactly the asked refs and leaves out absent or corrupt ones", async () => {
    const store = createMemoryAssetStore();

    store.setRaw("waveforms", digestOf(1), peaksOf(1, 2, 3));
    store.setRaw("waveforms", digestOf(2), {peaksPerSecond: 0, peaks: Uint8Array.from([1])});
    store.setRaw("waveforms", digestOf(4), peaksOf(9));

    const waveforms = await readStoryWaveforms(store, [audioRef(1), audioRef(2), audioRef(3), audioRef(1)]);

    assert.deepEqual([...waveforms.keys()], [audioRef(1)]);
    assert.deepEqual(waveforms.get(audioRef(1)), peaksOf(1, 2, 3));
  });

  it("never lets a record under one digest answer for another (identity is the key)", async () => {
    const store = createMemoryAssetStore();

    store.setRaw("waveforms", digestOf(1), {...peaksOf(1), digest: digestOf(2)});
    store.setRaw("waveforms", digestOf(2), peaksOf(2));

    const waveforms = await readStoryWaveforms(store, [audioRef(1), audioRef(2)]);

    assert.deepEqual([...waveforms.keys()], [audioRef(2)]);
  });
});

describe("startWaveformRead (the hook's effect)", () => {
  it("settles once with the Story's peaks; a cancelled read settles nothing; a failed read settles the empty map", async () => {
    const store = createMemoryAssetStore();

    store.setRaw("waveforms", digestOf(1), peaksOf(5, 6));

    const settled = [];

    startWaveformRead(store, [audioRef(1)], (map) => settled.push(map));
    await flush();
    assert.equal(settled.length, 1);
    assert.deepEqual(settled[0].get(audioRef(1)), peaksOf(5, 6));

    const late = [];
    const cancel = startWaveformRead(store, [audioRef(1)], (map) => late.push(map));

    cancel();
    await flush();
    assert.deepEqual(late, []);

    const failed = [];

    startWaveformRead(
      {getWaveform: async () => { throw new Error("closed"); }},
      [audioRef(1)],
      (map) => failed.push(map),
    );
    await flush();
    assert.equal(failed.length, 1);
    assert.equal(failed[0].size, 0);
  });

  it("no library or no local refs settles the empty map at once", () => {
    const settled = [];

    startWaveformRead(null, [audioRef(1)], (map) => settled.push(map));
    startWaveformRead(createMemoryAssetStore(), [], (map) => settled.push(map));
    assert.deepEqual(settled.map((map) => map.size), [0, 0]);
  });

  it("the hook restarts it when the library, the refs or the refresh token change", () => {
    const source = readFileSync("src/web/audio/storyWaveforms.ts", "utf8");

    assert.match(source, /startWaveformRead\(store, parseLocalAudioRefsKey\(refsKey\)/u);
    assert.match(source, /\[store, refsKey, refreshToken\]/u);
  });
});

describe("waveform maps", () => {
  it("sameWaveforms compares by content, so a re-read of an unchanged library keeps the map", () => {
    const a = new Map([[audioRef(1), peaksOf(1, 2, 3)]]);

    assert.equal(sameWaveforms(a, new Map([[audioRef(1), peaksOf(1, 2, 3)]])), true);
    assert.equal(sameWaveforms(a, new Map([[audioRef(1), peaksOf(1, 2, 4)]])), false);
    assert.equal(sameWaveforms(a, new Map([[audioRef(1), peaksOf(1, 2)]])), false);
    assert.equal(sameWaveforms(a, new Map([[audioRef(2), peaksOf(1, 2, 3)]])), false);
    assert.equal(sameWaveforms(a, new Map()), false);
    assert.equal(sameWaveforms(new Map(), new Map()), true);
    assert.equal(
      sameWaveforms(a, new Map([[audioRef(1), {peaksPerSecond: 25, peaks: Uint8Array.from([1, 2, 3])}]])),
      false,
    );
  });

  it("merges the bundled store's ready peaks with the local ones and ignores every other state", () => {
    const local = new Map([[audioRef(1), peaksOf(1)]]);
    const merged = mergeWaveforms(local, new Map([
      ["ding", {kind: "ready", peaks: peaksOf(7), blob: new Blob([]), url: "blob:a"}],
      ["pop", {kind: "loading"}],
      ["boom", {kind: "unusable", message: "x"}],
      ["whoosh", {kind: "fetch-failed", message: "x"}],
    ]));

    assert.deepEqual([...merged.keys()].sort(), [audioRef(1), "ding"].sort());
    assert.deepEqual(merged.get("ding"), peaksOf(7));
    assert.equal(local.size, 1, "the local map is not changed");
  });
});
