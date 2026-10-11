import assert from "node:assert/strict";
import {afterEach, describe, it} from "node:test";
import {installRenderStateRecorder} from "./browser/helpers/renderStates.mjs";

const globals = ["document", "window", "MutationObserver"];
const saved = new Map(globals.map((name) => [name, globalThis[name]]));

/** Installs the recorder against a fake DOM and returns how to drive it. */
const install = (initialState) => {
  let current = initialState;
  let callback = null;
  let options = null;
  const target = {getAttribute: () => current};

  globalThis.document = {querySelector: () => target};
  globalThis.window = {};
  globalThis.MutationObserver = class {
    constructor(handler) {
      callback = handler;
    }

    observe(_target, observeOptions) {
      options = observeOptions;
    }
  };

  installRenderStateRecorder();

  return {
    options: () => options,
    states: () => globalThis.window.__renderStates,
    /** One batched callback; `changes` are the successive attribute values. */
    deliver: (...changes) => {
      const records = [];
      let previous = current;

      for (const next of changes) {
        records.push({oldValue: previous});
        previous = next;
      }

      current = previous;
      callback(records);
    },
  };
};

describe("tests/browser/helpers/renderStates.mjs", () => {
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete globalThis[name];
      } else {
        globalThis[name] = value;
      }
    }
  });

  it("asks for the old attribute value", () => {
    const recorder = install("idle");

    assert.equal(recorder.options().attributeOldValue, true);
  });

  it("records both states of a batch that went cancelling -> idle, not the starting state", () => {
    const recorder = install("rendering");

    recorder.deliver("cancelling", "idle");

    assert.deepEqual(recorder.states(), ["cancelling", "idle"]);
  });

  it("records states across separate batches, skipping consecutive duplicates", () => {
    const recorder = install("idle");

    recorder.deliver("rendering");
    recorder.deliver("rendering", "cancelling");
    recorder.deliver("idle");

    assert.deepEqual(recorder.states(), ["rendering", "cancelling", "idle"]);
  });

  it("does not count the starting state as entered", () => {
    const recorder = install("success");

    recorder.deliver("rendering", "cancelling", "idle");

    assert.ok(!recorder.states().includes("success"));
    assert.deepEqual(recorder.states(), ["rendering", "cancelling", "idle"]);
  });
});
