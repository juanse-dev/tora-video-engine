import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  applyArmingAction,
  nextArmingAction,
} from "../src/web/audioArming.ts";
import {
  PLAYER_VOLUME_STORAGE_KEY,
  readStoredPlayerVolume,
  storePlayerVolume,
} from "../src/web/playerVolume.ts";

describe("audio arming handshake", () => {
  it("arms on the first audible render, disarms on a silent one and otherwise does nothing", () => {
    assert.equal(nextArmingAction(true, false), "arm");
    assert.equal(nextArmingAction(true, true), "none");
    assert.equal(nextArmingAction(false, true), "disarm");
    assert.equal(nextArmingAction(false, false), "none");
  });

  it("mutes the Player first and arms second, never the reverse", () => {
    const log = [];
    const player = {mute: () => log.push("mute")};

    assert.equal(
      applyArmingAction("arm", player, (armed) => log.push(`armed:${armed}`)),
      true,
    );
    assert.deepEqual(log, ["mute", "armed:true"]);
  });

  it("waits for the Player instead of arming without it", () => {
    const log = [];

    assert.equal(
      applyArmingAction("arm", null, (armed) => log.push(`armed:${armed}`)),
      false,
    );
    assert.deepEqual(log, []);
  });

  it("disarms without touching the mute state", () => {
    const log = [];
    const player = {mute: () => log.push("mute")};

    applyArmingAction("disarm", player, (armed) => log.push(`armed:${armed}`));
    applyArmingAction("none", player, (armed) => log.push(`armed:${armed}`));
    assert.deepEqual(log, ["armed:false"]);
  });

  it("mutes on every silent -> audible transition and never while an audible Story is edited", () => {
    let armed = false;
    const log = [];
    const player = {mute: () => log.push("mute")};
    // The layout effect re-runs after each state change until nothing is left to do.
    const render = (hasAudio) => {
      for (let pass = 0; pass < 3; pass += 1) {
        const action = nextArmingAction(hasAudio, armed);

        applyArmingAction(action, player, (next) => {
          armed = next;
        });

        if (action === "none") {
          return;
        }
      }
    };

    // audio, three edits that keep the audio, silent, silent, audio again.
    for (const hasAudio of [true, true, true, true, false, false, true, true]) {
      render(hasAudio);
    }

    assert.deepEqual(log, ["mute", "mute"]);
    assert.equal(armed, true);
  });
});

describe("remembered Player volume", () => {
  const storageWith = (value) => ({
    getItem: (key) => (key === PLAYER_VOLUME_STORAGE_KEY ? value : "wrong key"),
    setItem: () => {},
  });

  it("uses the key tora.playerVolume", () => {
    assert.equal(PLAYER_VOLUME_STORAGE_KEY, "tora.playerVolume");
  });

  it("reads a stored volume in [0, 1]", () => {
    assert.equal(readStoredPlayerVolume(() => storageWith("0.4")), 0.4);
    assert.equal(readStoredPlayerVolume(() => storageWith("0")), 0);
    assert.equal(readStoredPlayerVolume(() => storageWith("1")), 1);
  });

  it("reads nothing for missing, empty, garbage or out-of-range values", () => {
    for (const value of [
      null,
      "",
      "   ",
      "banana",
      "NaN",
      "Infinity",
      "-0.1",
      "1.0000001",
      "7",
    ]) {
      assert.equal(readStoredPlayerVolume(() => storageWith(value)), null, String(value));
    }
  });

  it("survives a throwing or missing localStorage", () => {
    assert.equal(
      readStoredPlayerVolume(() => {
        throw new Error("SecurityError");
      }),
      null,
    );
    assert.equal(
      readStoredPlayerVolume(() => ({
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {},
      })),
      null,
    );
    assert.equal(readStoredPlayerVolume(() => null), null);
    // No `window` in Node: the default accessor also yields null instead of throwing.
    assert.equal(readStoredPlayerVolume(), null);
  });

  it("stores a volume as a plain number string", () => {
    const writes = [];

    storePlayerVolume(0.25, () => ({
      getItem: () => null,
      setItem: (key, value) => writes.push([key, value]),
    }));
    assert.deepEqual(writes, [["tora.playerVolume", "0.25"]]);
  });

  it("never stores an invalid volume and survives a throwing setItem or accessor", () => {
    const writes = [];
    const recording = () => ({
      getItem: () => null,
      setItem: (key, value) => writes.push([key, value]),
    });

    for (const volume of [Number.NaN, -0.1, 1.5, Number.POSITIVE_INFINITY]) {
      storePlayerVolume(volume, recording);
    }

    assert.deepEqual(writes, []);
    assert.doesNotThrow(() =>
      storePlayerVolume(0.5, () => ({
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      })),
    );
    assert.doesNotThrow(() =>
      storePlayerVolume(0.5, () => {
        throw new Error("SecurityError");
      }),
    );
    assert.doesNotThrow(() => storePlayerVolume(0.5));
  });
});
