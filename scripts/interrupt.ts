/**
 * Ctrl+C / SIGTERM handling for `npm run video` (ASSET-005 R9, issue #37).
 *
 * While a render runs, the parent process owns a temporary directory that
 * must be removed even when the user interrupts the render. The guard below
 * installs the signal handlers, forwards the signal to the Remotion child and
 * lets `renderStory` finish its normal cleanup before the process exits.
 */

export type InterruptSignal = "SIGINT" | "SIGTERM" | "SIGBREAK";

/** The part of `process` the guard uses; tests pass an EventEmitter. */
export type SignalSource = {
  on(signal: InterruptSignal, listener: () => void): unknown;
  off(signal: InterruptSignal, listener: () => void): unknown;
};

/** The part of a child process the guard uses. */
export type KillableChild = {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
};

export type Timers = {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
};

export type InterruptGuardOptions = {
  /** Defaults to `process`. */
  signals?: SignalSource;
  /** Defaults to `process.platform`; `win32` also handles SIGBREAK. */
  platform?: string;
  /** How long the child gets to exit before SIGKILL. Defaults to 10 s. */
  killTimeoutMs?: number;
  /** Defaults to the global timers. */
  timers?: Timers;
};

/** Handed to the Remotion runner so the guard can reach the child. */
export type RenderControl = {
  attach(child: KillableChild): void;
};

export type InterruptGuard = RenderControl & {
  /** The first signal received, if any. */
  readonly signal: InterruptSignal | null;
  /** Throws `RenderInterruptedError` once a signal was received. */
  throwIfInterrupted(): void;
  /** Removes the handlers and any pending timer. Idempotent. */
  dispose(): void;
};

export const DEFAULT_KILL_TIMEOUT_MS = 10_000;

export const INTERRUPT_MESSAGE =
  "Render interrupted; cleaned up the temporary files.";

/**
 * SIGBREAK (Ctrl+Break, Windows only) counts as Ctrl+C: same exit code, and
 * it is forwarded to the child as SIGINT (Node cannot kill with SIGBREAK).
 */
const EXIT_CODES: Record<InterruptSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGBREAK: 130,
};

export const exitCodeForSignal = (signal: InterruptSignal): number =>
  EXIT_CODES[signal];

export class RenderInterruptedError extends Error {
  readonly signal: InterruptSignal;
  readonly exitCode: number;

  constructor(signal: InterruptSignal) {
    super(`Render interrupted by ${signal}`);
    this.name = "RenderInterruptedError";
    this.signal = signal;
    this.exitCode = exitCodeForSignal(signal);
  }
}

const globalTimers: Timers = {
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export const createInterruptGuard = (
  options: InterruptGuardOptions = {},
): InterruptGuard => {
  const signals = options.signals ?? (process as SignalSource);
  const timers = options.timers ?? globalTimers;
  const killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
  const names: InterruptSignal[] = ["SIGINT", "SIGTERM"];

  if ((options.platform ?? process.platform) === "win32") {
    names.push("SIGBREAK");
  }

  let first: InterruptSignal | null = null;
  let child: KillableChild | null = null;
  let childExited = false;
  let killTimer: unknown = null;
  let disposed = false;

  const stopKillTimer = (): void => {
    if (killTimer !== null) {
      timers.clear(killTimer);
      killTimer = null;
    }
  };

  const killChild = (signal: NodeJS.Signals): void => {
    if (child === null || childExited) {
      return;
    }

    try {
      child.kill(signal);
    } catch {
      // The child is already gone (or cannot be signalled): the `close`
      // event, or the SIGKILL timer, settles the run either way.
    }
  };

  const onChildClose = (): void => {
    childExited = true;
    stopKillTimer();
  };

  const handle = (signal: InterruptSignal): void => {
    if (first !== null) {
      // A second signal means "stop waiting": kill the child now. The
      // cleanup of the temporary files still runs; it is never skipped.
      killChild("SIGKILL");

      return;
    }

    first = signal;
    killChild(signal === "SIGBREAK" ? "SIGINT" : signal);

    if (child !== null && !childExited) {
      killTimer = timers.set(() => {
        killTimer = null;
        killChild("SIGKILL");
      }, killTimeoutMs);
    }
  };

  const listeners = new Map<InterruptSignal, () => void>();

  for (const name of names) {
    const listener = (): void => handle(name);

    listeners.set(name, listener);
    signals.on(name, listener);
  }

  return {
    get signal() {
      return first;
    },
    attach(next) {
      child = next;
      childExited = false;
      next.once("close", onChildClose);

      if (first !== null) {
        // A signal arrived between the check and the spawn: stop the child.
        killChild("SIGKILL");
      }
    },
    throwIfInterrupted() {
      if (first !== null) {
        throw new RenderInterruptedError(first);
      }
    },
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      stopKillTimer();
      child?.off("close", onChildClose);

      for (const [name, listener] of listeners) {
        signals.off(name, listener);
      }
    },
  };
};

export type ReportIo = {
  error(line: string): void;
  exit(code: number): void;
};

/** The CLI's last word: one line to stderr and the exit code. */
export const reportRenderError = (error: unknown, io: ReportIo): void => {
  if (error instanceof RenderInterruptedError) {
    io.error(INTERRUPT_MESSAGE);
    io.exit(error.exitCode);

    return;
  }

  io.error(error instanceof Error ? error.message : String(error));
  io.exit(1);
};
