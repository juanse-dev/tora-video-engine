import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  AUDIO_DECODE_TIMEOUT_MS,
  AudioDecodeCache,
} from "../src/web/assetLibrary/audioDecodeCache.ts";

const metadata = (durationSeconds = 10) => ({
  container: "wave",
  codec: "pcm",
  durationSeconds,
  sampleRate: 48_000,
  channels: 2,
});
const blob = () => new Blob(["audio"]);
const digestOf = (n) => n.toString(16).padStart(64, "0");

/** A decode the test settles by hand; `calls` records every digest it was started for. */
const controlledDecode = () => {
  const calls = [];
  const pending = [];
  let active = 0;
  let maxActive = 0;
  const decode = (_blob, meta) => {
    calls.push(meta);
    active += 1;
    maxActive = Math.max(maxActive, active);

    return new Promise((resolve, reject) => {
      pending.push({
        resolve: (decodedSeconds) => {
          active -= 1;
          resolve({decodedSeconds});
        },
        reject: (error) => {
          active -= 1;
          reject(error);
        },
      });
    });
  };

  return {decode, calls, pending, maxActive: () => maxActive};
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("AudioDecodeCache", () => {
  it("decodes a source once per session and answers later renders from the cache", async () => {
    const control = controlledDecode();
    const cache = new AudioDecodeCache(control.decode);
    const first = cache.verify(digestOf(1), blob(), metadata());

    await tick();
    control.pending[0].resolve(10);
    assert.deepEqual(await first, {ok: true});
    assert.equal(cache.has(digestOf(1)), true);
    assert.deepEqual(await cache.verify(digestOf(1), blob(), metadata()), {ok: true});
    assert.equal(control.calls.length, 1);
  });

  it("applies the D-9 truncation rule: 0.2 s short passes, 0.3 s short fails and is not cached", async () => {
    const outcomes = [];

    for (const decoded of [9.8, 9.7, 0]) {
      const cache = new AudioDecodeCache(async () => ({decodedSeconds: decoded}));

      outcomes.push([decoded, await cache.verify(digestOf(1), blob(), metadata()), cache.has(digestOf(1))]);
    }

    assert.deepEqual(outcomes[0], [9.8, {ok: true}, true]);
    assert.deepEqual(outcomes[1], [9.7, {ok: false, detail: "only 9.70 s of 10.00 s could be decoded"}, false]);
    assert.deepEqual(outcomes[2], [0, {ok: false, detail: "only 0.00 s of 10.00 s could be decoded"}, false]);
  });

  it("turns a decode error into a failure with the error's message, and decodes again next time", async () => {
    let calls = 0;
    const cache = new AudioDecodeCache(async () => {
      calls += 1;

      if (calls === 1) {
        throw new Error("This audio file could not be decoded.");
      }

      return {decodedSeconds: 10};
    });

    assert.deepEqual(await cache.verify(digestOf(1), blob(), metadata()), {
      ok: false,
      detail: "This audio file could not be decoded.",
    });
    assert.deepEqual(await cache.verify(digestOf(1), blob(), metadata()), {ok: true});
    assert.equal(calls, 2);
  });

  it("shares one in-flight decode between callers of the same digest", async () => {
    const control = controlledDecode();
    const cache = new AudioDecodeCache(control.decode);
    const first = cache.verify(digestOf(1), blob(), metadata());
    const second = cache.verify(digestOf(1), blob(), metadata());

    await tick();
    assert.equal(control.calls.length, 1);
    control.pending[0].resolve(10);
    assert.deepEqual(await Promise.all([first, second]), [{ok: true}, {ok: true}]);
  });

  it("decodes one source at a time, page-wide", async () => {
    const control = controlledDecode();
    const cache = new AudioDecodeCache(control.decode);
    const all = [1, 2, 3].map((n) => cache.verify(digestOf(n), blob(), metadata()));

    for (let n = 0; n < 3; n += 1) {
      await tick();
      assert.equal(control.calls.length, n + 1);
      control.pending[n].resolve(10);
    }

    assert.deepEqual(await Promise.all(all), [{ok: true}, {ok: true}, {ok: true}]);
    assert.equal(control.maxActive(), 1);
  });

  it("re-decodes after an invalidation of a cached digest", async () => {
    let calls = 0;
    const cache = new AudioDecodeCache(async () => {
      calls += 1;

      return {decodedSeconds: 10};
    });

    await cache.verify(digestOf(1), blob(), metadata());
    await cache.verify(digestOf(2), blob(), metadata());
    cache.invalidate([digestOf(1)]);
    assert.equal(cache.has(digestOf(1)), false);
    assert.equal(cache.has(digestOf(2)), true);
    await cache.verify(digestOf(1), blob(), metadata());
    assert.equal(calls, 3);
    cache.clear();
    assert.equal(cache.has(digestOf(2)), false);
  });

  it("an invalidation while a decode is in flight wins: the result reaches its callers but is not cached", async () => {
    const control = controlledDecode();
    const cache = new AudioDecodeCache(control.decode);
    const first = cache.verify(digestOf(1), blob(), metadata());

    await tick();
    cache.invalidate([digestOf(1)]);
    control.pending[0].resolve(10);
    assert.deepEqual(await first, {ok: true});
    assert.equal(cache.has(digestOf(1)), false);

    // The next caller starts a fresh decode.
    const second = cache.verify(digestOf(1), blob(), metadata());

    await tick();
    assert.equal(control.calls.length, 2);
    control.pending[1].resolve(10);
    assert.deepEqual(await second, {ok: true});
    assert.equal(cache.has(digestOf(1)), true);
  });

  it("aborting stops one caller from waiting without poisoning the cache or the other caller", async () => {
    const control = controlledDecode();
    const cache = new AudioDecodeCache(control.decode);
    const controller = new AbortController();
    const waiting = cache.verify(digestOf(1), blob(), metadata(), {signal: controller.signal});
    const other = cache.verify(digestOf(1), blob(), metadata());

    await tick();
    controller.abort();
    await assert.rejects(waiting, {name: "AbortError"});
    control.pending[0].resolve(10);
    assert.deepEqual(await other, {ok: true});
    assert.equal(cache.has(digestOf(1)), true);
    assert.equal(control.calls.length, 1);
  });

  it("a decode that nobody waits for any more is never started", async () => {
    const control = controlledDecode();
    const cache = new AudioDecodeCache(control.decode);
    const blocker = cache.verify(digestOf(1), blob(), metadata());
    const controller = new AbortController();
    const queued = cache.verify(digestOf(2), blob(), metadata(), {signal: controller.signal});

    await tick();
    controller.abort();
    await assert.rejects(queued, {name: "AbortError"});
    control.pending[0].resolve(10);
    await blocker;
    await tick();
    assert.equal(control.calls.length, 1);

    // A later caller of the cancelled digest decodes it normally.
    const later = cache.verify(digestOf(2), blob(), metadata());

    await tick();
    assert.equal(control.calls.length, 2);
    control.pending[1].resolve(10);
    assert.deepEqual(await later, {ok: true});
  });

  it("a decode that never settles fails after 30 s, is aborted, and does not block the next decode", async () => {
    const timers = [];
    const cleared = [];
    const signals = [];
    let calls = 0;
    const cache = new AudioDecodeCache(
      (_blob, _meta, deps) => {
        calls += 1;
        signals.push(deps.signal);

        // The first decode never settles; later ones answer at once.
        return calls === 1
          ? new Promise(() => undefined)
          : Promise.resolve({decodedSeconds: 10});
      },
      {
        timers: {
          setTimeout: (callback, milliseconds) => {
            timers.push({callback, milliseconds});

            return timers.length;
          },
          clearTimeout: (handle) => cleared.push(handle),
        },
      },
    );

    assert.equal(AUDIO_DECODE_TIMEOUT_MS, 30_000);

    const stuck = cache.verify(digestOf(1), blob(), metadata());
    const next = cache.verify(digestOf(2), blob(), metadata());

    await tick();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].milliseconds, 30_000);
    assert.equal(signals[0].aborted, false);

    timers[0].callback();
    assert.deepEqual(await stuck, {
      ok: false,
      detail: "the decode did not finish within 30 s",
    });
    assert.equal(signals[0].aborted, true);
    assert.equal(cache.has(digestOf(1)), false);

    // The queue moved on: the second source decodes, and its timer is cleared.
    assert.deepEqual(await next, {ok: true});
    assert.deepEqual(cleared, [2]);
  });

  it("an already-aborted signal rejects before any decode", async () => {
    const control = controlledDecode();
    const cache = new AudioDecodeCache(control.decode);
    const controller = new AbortController();

    controller.abort();
    await assert.rejects(
      cache.verify(digestOf(1), blob(), metadata(), {signal: controller.signal}),
      {name: "AbortError"},
    );
    assert.equal(control.calls.length, 0);
  });
});
