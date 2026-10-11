import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {EventEmitter} from "node:events";
import {readdirSync, writeFileSync} from "node:fs";
import {mkdir, mkdtemp, readdir, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {after, describe, it} from "node:test";
import {fileURLToPath} from "node:url";
import {
  createInterruptGuard,
  exitCodeForSignal,
  INTERRUPT_MESSAGE,
  RenderInterruptedError,
  reportRenderError,
} from "../scripts/interrupt.ts";
import {renderStory} from "../scripts/renderStory.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories = [];
const outputs = [];

after(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, {recursive: true, force: true});
  }

  for (const output of outputs) {
    await rm(output, {force: true});
  }
});

/** A stand-in for `process`: only `on` / `off`, never a real signal. */
const makeSignals = () => new EventEmitter();

/** A stand-in for the Remotion child that records `kill` calls. */
const makeChild = ({exitsOnKill = true} = {}) => {
  const child = new EventEmitter();

  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);

    if (exitsOnKill || signal === "SIGKILL") {
      queueMicrotask(() => child.emit("close", null, signal));
    }

    return true;
  };

  return child;
};

/** Timers that only fire when the test says so. */
const makeTimers = () => {
  const timers = {
    pending: [],
    set(callback, milliseconds) {
      const entry = {callback, milliseconds, cleared: false};

      timers.pending.push(entry);

      return entry;
    },
    clear(entry) {
      entry.cleared = true;
    },
    fire() {
      for (const entry of timers.pending) {
        if (!entry.cleared) {
          entry.cleared = true;
          entry.callback();
        }
      }
    },
    active: () => timers.pending.filter((entry) => !entry.cleared),
  };

  return timers;
};

const storyYaml = [
  'title: "T37"',
  "scenes:",
  "  - type: intro",
  "    pose: formal",
  "    background: office",
  "    animation: fade",
  '    text: "Hi"',
  "    duration: 1",
  "",
].join("\n");

const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), "tora-interrupt-test-"));

  temporaryDirectories.push(directory);

  const slug = `t37-${directory.slice(-6).toLowerCase().replace(/[^a-z0-9]/gu, "x")}`;
  const storyPath = join(directory, `${slug}.yaml`);
  const tempBase = join(directory, "tmp");
  const outputPath = join(repoRoot, "output", `${slug}.mp4`);

  await mkdir(tempBase);
  await writeFile(storyPath, storyYaml);
  outputs.push(outputPath);

  return {storyPath, tempBase, outputPath};
};

const exists = async (path) => {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
};

const nextTurn = () =>
  new Promise((resolvePromise) => setImmediate(resolvePromise));

const deferred = () => {
  let resolveFn;
  const promise = new Promise((resolvePromise) => {
    resolveFn = resolvePromise;
  });

  return {promise, resolve: resolveFn};
};

/**
 * A `runRemotion` that attaches `child`, leaves a partial output file and
 * settles when the child closes (as the real runner does).
 */
const makeRunner = (child, started) => async (_executable, args, control) => {
  const outputPath = args[4];

  await mkdir(dirname(outputPath), {recursive: true});
  await writeFile(outputPath, "partial");
  control.attach(child);
  started.resolve();
  await new Promise((_resolve, reject) => {
    child.once("close", (code, signal) => {
      reject(new Error(`Remotion render failed with ${signal ?? code}`));
    });
  });
};

const settle = (promise) =>
  promise.then(
    () => null,
    (error) => error,
  );

describe("signal exit codes", () => {
  it("maps signals to the conventional exit codes", () => {
    assert.equal(exitCodeForSignal("SIGINT"), 130);
    assert.equal(exitCodeForSignal("SIGTERM"), 143);
    assert.equal(exitCodeForSignal("SIGBREAK"), 130);
  });
});

describe("renderStory interruption", () => {
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    it(`forwards ${signal}, cleans up after the child exits and reports ${code}`, async () => {
      const {storyPath, tempBase, outputPath} = await setup();
      const signals = makeSignals();
      const timers = makeTimers();
      const child = makeChild();
      const started = deferred();

      const outcome = settle(
        renderStory(storyPath, {
          tempBase,
          runRemotion: makeRunner(child, started),
          interrupt: {signals, timers, platform: "linux"},
        }),
      );

      await started.promise;
      assert.equal((await readdir(tempBase)).length, 1);
      assert.ok(await exists(outputPath));

      signals.emit(signal);

      const error = await outcome;

      assert.ok(error instanceof RenderInterruptedError);
      assert.equal(error.signal, signal);
      assert.equal(error.exitCode, code);
      assert.deepEqual(child.kills, [signal]);
      assert.deepEqual(await readdir(tempBase), []);
      assert.equal(await exists(outputPath), false);
      assert.equal(signals.listenerCount("SIGINT"), 0);
      assert.equal(signals.listenerCount("SIGTERM"), 0);
      assert.deepEqual(timers.active(), []);
    });
  }

  it("sends SIGKILL when the child ignores the forwarded signal", async () => {
    const {storyPath, tempBase, outputPath} = await setup();
    const signals = makeSignals();
    const timers = makeTimers();
    const child = makeChild({exitsOnKill: false});
    const started = deferred();

    const outcome = settle(
      renderStory(storyPath, {
        tempBase,
        runRemotion: makeRunner(child, started),
        interrupt: {signals, timers, killTimeoutMs: 1234, platform: "linux"},
      }),
    );

    await started.promise;
    signals.emit("SIGINT");
    await nextTurn();

    assert.deepEqual(child.kills, ["SIGINT"]);
    assert.equal(timers.active().length, 1);
    assert.equal(timers.active()[0].milliseconds, 1234);
    // The temporary directory stays until the child is really gone.
    assert.equal((await readdir(tempBase)).length, 1);

    timers.fire();

    const error = await outcome;

    assert.deepEqual(child.kills, ["SIGINT", "SIGKILL"]);
    assert.ok(error instanceof RenderInterruptedError);
    assert.equal(error.exitCode, 130);
    assert.deepEqual(await readdir(tempBase), []);
    assert.equal(await exists(outputPath), false);
  });

  it("defaults the kill timeout to 10 seconds", async () => {
    const {storyPath, tempBase} = await setup();
    const signals = makeSignals();
    const timers = makeTimers();
    const child = makeChild({exitsOnKill: false});
    const started = deferred();

    const outcome = settle(
      renderStory(storyPath, {
        tempBase,
        runRemotion: makeRunner(child, started),
        interrupt: {signals, timers, platform: "linux"},
      }),
    );

    await started.promise;
    signals.emit("SIGTERM");
    assert.equal(timers.active()[0].milliseconds, 10_000);
    timers.fire();
    await outcome;
  });

  it("does not send SIGKILL after the child exited in time", async () => {
    const {storyPath, tempBase} = await setup();
    const signals = makeSignals();
    const timers = makeTimers();
    const child = makeChild();
    const started = deferred();

    const outcome = settle(
      renderStory(storyPath, {
        tempBase,
        runRemotion: makeRunner(child, started),
        interrupt: {signals, timers, platform: "linux"},
      }),
    );

    await started.promise;
    signals.emit("SIGTERM");
    await outcome;
    timers.fire();

    assert.deepEqual(child.kills, ["SIGTERM"]);
  });

  it("escalates a second signal to SIGKILL without skipping the cleanup", async () => {
    const {storyPath, tempBase, outputPath} = await setup();
    const signals = makeSignals();
    const timers = makeTimers();
    const child = makeChild({exitsOnKill: false});
    const started = deferred();

    const outcome = settle(
      renderStory(storyPath, {
        tempBase,
        runRemotion: makeRunner(child, started),
        interrupt: {signals, timers, platform: "linux"},
      }),
    );

    await started.promise;
    signals.emit("SIGINT");
    await nextTurn();
    signals.emit("SIGINT");
    signals.emit("SIGTERM");

    const error = await outcome;

    assert.deepEqual(child.kills, ["SIGINT", "SIGKILL", "SIGKILL"]);
    // The first signal decides the exit code.
    assert.equal(error.signal, "SIGINT");
    assert.equal(error.exitCode, 130);
    assert.deepEqual(await readdir(tempBase), []);
    assert.equal(await exists(outputPath), false);
  });

  it("keeps the handlers installed until the temporary files are removed", async () => {
    const {storyPath, tempBase} = await setup();
    const signals = makeSignals();
    const child = makeChild();
    const started = deferred();
    const entriesWhenRemoved = [];
    const off = signals.off.bind(signals);

    signals.off = (event, listener) => {
      entriesWhenRemoved.push(readdirSync(tempBase).length);

      return off(event, listener);
    };

    const outcome = settle(
      renderStory(storyPath, {
        tempBase,
        runRemotion: makeRunner(child, started),
        interrupt: {signals, timers: makeTimers(), platform: "linux"},
      }),
    );

    await started.promise;
    signals.emit("SIGINT");
    await outcome;

    // Both handlers went away only after the directory was already gone.
    assert.deepEqual(entriesWhenRemoved, [0, 0]);
  });

  it("does not start the render when a signal arrived before the child", async () => {
    const {storyPath, tempBase, outputPath} = await setup();
    let spawned = false;
    // The signal "arrives" as soon as the handlers are installed, which is
    // before Remotion would be started.
    const signals = new (class extends EventEmitter {
      on(event, listener) {
        super.on(event, listener);

        if (event === "SIGTERM") {
          this.emit("SIGTERM");
        }

        return this;
      }
    })();

    const error = await settle(
      renderStory(storyPath, {
        tempBase,
        runRemotion: async () => {
          spawned = true;
        },
        interrupt: {signals, timers: makeTimers(), platform: "linux"},
      }),
    );

    assert.equal(spawned, false);
    assert.ok(error instanceof RenderInterruptedError);
    assert.equal(error.exitCode, 143);
    assert.deepEqual(await readdir(tempBase), []);
    assert.equal(await exists(outputPath), false);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  });

  it("removes the handlers after a normal render and keeps the output", async () => {
    const {storyPath, tempBase, outputPath} = await setup();
    const signals = makeSignals();
    const timers = makeTimers();

    await renderStory(storyPath, {
      tempBase,
      runRemotion: async (_executable, args, control) => {
        control.attach(makeChild());
        assert.equal(signals.listenerCount("SIGINT"), 1);
        assert.equal(signals.listenerCount("SIGTERM"), 1);
        await mkdir(dirname(args[4]), {recursive: true});
        await writeFile(args[4], "video");
      },
      interrupt: {signals, timers, platform: "linux"},
    });

    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
    assert.equal(signals.listenerCount("SIGBREAK"), 0);
    assert.deepEqual(timers.active(), []);
    assert.ok(await exists(outputPath));
    assert.deepEqual(await readdir(tempBase), []);
  });

  for (const [label, runnerFails] of [
    ["a finished render", false],
    ["a failed render", true],
  ]) {
    it(`discards ${label} when a signal arrives during the final cleanup`, async () => {
      const {storyPath, tempBase, outputPath} = await setup();
      const signals = makeSignals();
      const removed = [];

      const error = await settle(
        renderStory(storyPath, {
          tempBase,
          runRemotion: async (_executable, args, control) => {
            const child = makeChild();

            control.attach(child);
            await mkdir(dirname(args[4]), {recursive: true});
            await writeFile(args[4], "video");
            child.emit("close", runnerFails ? 1 : 0, null);

            if (runnerFails) {
              throw new Error("Remotion render failed with exit code 1");
            }
          },
          // The signal lands while the temporary directory is being removed.
          removeDirectory: async (path, options) => {
            signals.emit("SIGINT");
            // Still installed: the signal must not hit the default handler.
            removed.push(signals.listenerCount("SIGINT"));
            await rm(path, options);
          },
          interrupt: {signals, timers: makeTimers(), platform: "linux"},
        }),
      );

      assert.ok(error instanceof RenderInterruptedError);
      assert.equal(error.exitCode, 130);
      assert.deepEqual(removed, [1]);
      assert.equal(await exists(outputPath), false);
      assert.deepEqual(await readdir(tempBase), []);
      assert.equal(signals.listenerCount("SIGINT"), 0);
    });
  }

  it("handles a signal that lands while the temporary directory is being created", async () => {
    const {storyPath, tempBase, outputPath} = await setup();
    const signals = makeSignals();
    let listening = null;
    let ran = false;

    const error = await settle(
      renderStory(storyPath, {
        tempBase,
        runRemotion: async () => {
          ran = true;
        },
        // The directory exists on disk before the signal lands.
        makeTempDirectory: async (prefix) => {
          const created = await mkdtemp(prefix);

          listening = signals.listenerCount("SIGINT");
          signals.emit("SIGINT");

          return created;
        },
        interrupt: {signals, timers: makeTimers(), platform: "linux"},
      }),
    );

    // Already installed: the signal must not hit the default handler.
    assert.equal(listening, 1);
    assert.ok(error instanceof RenderInterruptedError);
    assert.equal(error.exitCode, 130);
    assert.equal(ran, false);
    assert.equal(await exists(outputPath), false);
    assert.deepEqual(await readdir(tempBase), []);
    assert.equal(signals.listenerCount("SIGINT"), 0);
  });

  it("reports a failed temporary-directory removal after a signal instead of claiming cleanup", async () => {
    const {storyPath, tempBase, outputPath} = await setup();
    const signals = makeSignals();
    const busy = Object.assign(new Error("EBUSY: resource busy"), {code: "EBUSY"});
    let leftBehind = null;

    const error = await settle(
      renderStory(storyPath, {
        tempBase,
        runRemotion: async () => {
          signals.emit("SIGINT");
        },
        removeDirectory: async (path) => {
          leftBehind = path;
          throw busy;
        },
        interrupt: {signals, timers: makeTimers(), platform: "linux"},
      }),
    );

    assert.ok(error instanceof RenderInterruptedError);
    assert.equal(error.exitCode, 130);
    assert.deepEqual(error.cleanupFailure, {path: leftBehind, error: busy});
    assert.equal(await exists(outputPath), false);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    await rm(leftBehind, {recursive: true, force: true});
  });

  it("removes the handlers when the render fails", async () => {
    const {storyPath, tempBase} = await setup();
    const signals = makeSignals();

    await assert.rejects(
      renderStory(storyPath, {
        tempBase,
        runRemotion: async () => {
          throw new Error("Remotion render failed with exit code 1");
        },
        interrupt: {signals, timers: makeTimers(), platform: "linux"},
      }),
      /Remotion render failed/u,
    );

    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  });

  it("also handles SIGBREAK on Windows, as SIGINT", async () => {
    const {storyPath, tempBase} = await setup();
    const signals = makeSignals();
    const child = makeChild();
    const started = deferred();

    const outcome = settle(
      renderStory(storyPath, {
        tempBase,
        runRemotion: makeRunner(child, started),
        interrupt: {signals, timers: makeTimers(), platform: "win32"},
      }),
    );

    await started.promise;
    assert.equal(signals.listenerCount("SIGBREAK"), 1);
    signals.emit("SIGBREAK");

    const error = await outcome;

    assert.equal(error.exitCode, 130);
    assert.deepEqual(child.kills, ["SIGINT"]);
    assert.equal(signals.listenerCount("SIGBREAK"), 0);
    assert.deepEqual(await readdir(tempBase), []);
  });

  it("does not listen for SIGBREAK outside Windows", () => {
    const signals = makeSignals();
    const guard = createInterruptGuard({
      signals,
      timers: makeTimers(),
      platform: "linux",
    });

    assert.equal(signals.listenerCount("SIGBREAK"), 0);
    guard.dispose();
  });

  it("ignores a kill that throws because the child already exited", () => {
    const signals = makeSignals();
    const guard = createInterruptGuard({
      signals,
      timers: makeTimers(),
      platform: "linux",
    });
    const child = new EventEmitter();

    child.kill = () => {
      throw new Error("ESRCH");
    };
    guard.attach(child);
    assert.doesNotThrow(() => signals.emit("SIGINT"));
    assert.equal(guard.signal, "SIGINT");
    guard.dispose();
  });

  it("kills a child attached after a signal arrived", () => {
    const signals = makeSignals();
    const guard = createInterruptGuard({
      signals,
      timers: makeTimers(),
      platform: "linux",
    });
    const child = makeChild();

    signals.emit("SIGTERM");
    guard.attach(child);
    assert.deepEqual(child.kills, ["SIGKILL"]);
    guard.dispose();
  });

  it("really terminates a spawned child through the real runner", async () => {
    const {storyPath, tempBase, outputPath} = await setup();
    const signals = makeSignals();
    const children = [];
    const started = deferred();

    const outcome = settle(
      renderStory(storyPath, {
        tempBase,
        // Stands in for the Remotion CLI: a Node process that only sleeps.
        spawn: (_executable, args, options) => {
          // A partial output, as a killed render would leave behind.
          writeFileSync(args[4], "partial");

          const child = spawn(
            process.execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            options,
          );

          children.push(child);
          child.once("spawn", () => started.resolve());

          return child;
        },
        interrupt: {signals, platform: "linux"},
      }),
    );

    await started.promise;
    signals.emit("SIGTERM");

    const error = await outcome;

    assert.ok(error instanceof RenderInterruptedError);
    assert.equal(error.exitCode, 143);
    assert.equal(children.length, 1);
    assert.ok(children[0].exitCode !== null || children[0].signalCode !== null);
    assert.deepEqual(await readdir(tempBase), []);
    assert.equal(await exists(outputPath), false);
  });
});

describe("reportRenderError", () => {
  const makeIo = () => {
    const io = {lines: [], codes: []};

    io.error = (line) => io.lines.push(line);
    io.exit = (code) => io.codes.push(code);

    return io;
  };

  it("prints one short line and exits with the signal code", () => {
    const io = makeIo();

    reportRenderError(new RenderInterruptedError("SIGINT"), io);

    assert.deepEqual(io.lines, [INTERRUPT_MESSAGE]);
    assert.equal(
      INTERRUPT_MESSAGE,
      "Render interrupted; cleaned up the temporary files.",
    );
    assert.deepEqual(io.codes, [130]);

    const termIo = makeIo();

    reportRenderError(new RenderInterruptedError("SIGTERM"), termIo);
    assert.deepEqual(termIo.codes, [143]);
  });

  it("names the directory it could not remove instead of claiming cleanup", () => {
    const io = makeIo();

    reportRenderError(
      new RenderInterruptedError("SIGINT", {
        cleanupFailure: {path: "/tmp/tora-video-engine-x", error: new Error("EBUSY")},
      }),
      io,
    );

    assert.deepEqual(io.lines, [
      "Render interrupted; could not remove the temporary directory /tmp/tora-video-engine-x: EBUSY",
    ]);
    assert.deepEqual(io.codes, [130]);
  });

  it("keeps exit code 1 and the message for other failures", () => {
    const io = makeIo();

    reportRenderError(new Error("boom"), io);
    reportRenderError("plain", io);

    assert.deepEqual(io.lines, ["boom", "plain"]);
    assert.deepEqual(io.codes, [1, 1]);
  });
});
