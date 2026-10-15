import type {LocalAudioRef} from "../../localAssets/refs.ts";

/**
 * A quarter of a second of silence (8 kHz, 8-bit, mono). `start` plays it
 * synchronously inside the click, before the verified URL is known: Safari
 * only lets an element play when `play()` is called within the user's gesture,
 * and reading and verifying the stored bytes takes an `await` or more.
 */
export const SILENT_PRIMER_URL =
  "data:audio/wav;base64,UklGRvQHAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YdAHAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

/** The text a card shows when a preview could not start. */
export const AUDIO_PREVIEW_FAILED_MESSAGE = "This audio could not be played.";

/** A verified object URL for one sound, leased until `release`. */
export type PreviewUrlLease = {url: string; release: () => void};

export type AcquirePreviewUrl = (
  ref: LocalAudioRef,
  signal: AbortSignal,
) => Promise<PreviewUrlLease>;

/** The few members of `HTMLAudioElement` the coordinator uses (a fake in Node tests). */
export type PreviewAudioElement = {
  src: string;
  play: () => Promise<void>;
  pause: () => void;
  addEventListener: (type: "ended" | "error", listener: () => void) => void;
};

export type PreviewState =
  | {kind: "idle"}
  | {kind: "loading"; ref: LocalAudioRef}
  | {kind: "playing"; ref: LocalAudioRef}
  | {kind: "failed"; ref: LocalAudioRef; message: string};

const IDLE: PreviewState = {kind: "idle"};

/**
 * The page's ONE audio preview. A single element plays at most one sound, so
 * "one preview at a time across the page" cannot be broken by two cards. The
 * Player and the preview exclude each other: `toggle` pauses the Player it was
 * given, and `playerStarted` (called from the Player's `play` event) stops the
 * preview.
 *
 * The state object is replaced on every change and kept otherwise, so it can
 * feed `useSyncExternalStore`.
 */
export const createPreviewPlayback = (deps: {
  createAudio: () => PreviewAudioElement;
}) => {
  let audio: PreviewAudioElement | null = null;
  let state: PreviewState = IDLE;
  let generation = 0;
  let abort: AbortController | null = null;
  let lease: PreviewUrlLease | null = null;
  let pausePlayer: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: PreviewState) => {
    state = next;

    for (const listener of [...listeners]) {
      listener();
    }
  };

  const releaseLease = () => {
    const held = lease;

    lease = null;
    held?.release();
  };

  const element = (): PreviewAudioElement => {
    if (audio === null) {
      const created = deps.createAudio();
      const current = (): boolean => audio === created;

      created.addEventListener("ended", () => {
        if (current() && state.kind === "playing") {
          stop();
        }
      });
      created.addEventListener("error", () => {
        if (current() && state.kind === "playing") {
          fail(state.ref);
        }
      });
      audio = created;
    }

    return audio;
  };

  const halt = () => {
    generation += 1;
    abort?.abort();
    abort = null;
    audio?.pause();
    releaseLease();
  };

  const fail = (ref: LocalAudioRef) => {
    halt();
    publish({kind: "failed", ref, message: AUDIO_PREVIEW_FAILED_MESSAGE});
  };

  const stop = () => {
    halt();

    if (state.kind !== "idle") {
      publish(IDLE);
    }
  };

  const start = async (ref: LocalAudioRef, acquire: AcquirePreviewUrl) => {
    halt();

    const mine = generation;
    const controller = new AbortController();

    abort = controller;
    publish({kind: "loading", ref});
    // Pause the Player now, not when the sound is ready: the two never overlap.
    pausePlayer?.();

    // Prime the shared element inside the click, before the first await (see
    // SILENT_PRIMER_URL); the verified URL replaces the source below. A rejected
    // primer is harmless: the real play() below decides success or failure.
    const primed = element();

    primed.src = SILENT_PRIMER_URL;
    primed.play().catch(() => {});

    let acquired: PreviewUrlLease;

    try {
      acquired = await acquire(ref, controller.signal);
    } catch {
      if (generation === mine) {
        fail(ref);
      }

      return;
    }

    if (generation !== mine) {
      acquired.release();

      return;
    }

    lease = acquired;

    try {
      const playing = element();

      playing.src = acquired.url;
      await playing.play();
    } catch {
      if (generation === mine) {
        fail(ref);
      }

      return;
    }

    if (generation === mine) {
      publish({kind: "playing", ref});
    }
  };

  return {
    getState: (): PreviewState => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    /** Play or Stop for `ref`: stops this sound when it is the one loading or playing, otherwise starts it (stopping any other). */
    toggle: async (ref: LocalAudioRef, acquire: AcquirePreviewUrl) => {
      if (
        (state.kind === "loading" || state.kind === "playing") &&
        state.ref === ref
      ) {
        stop();

        return;
      }

      await start(ref, acquire);
    },
    stop,
    /** Stops the preview only when it belongs to `ref` (the card is going away). */
    stopRef: (ref: LocalAudioRef) => {
      if (state.kind !== "idle" && state.ref === ref) {
        stop();
      }
    },
    /** Called from the Player's `play` event. */
    playerStarted: stop,
    /** The Player's `pause`, or null when no Player is mounted. */
    setPlayerPause: (pause: (() => void) | null) => {
      pausePlayer = pause;
    },
  };
};

export type PreviewPlayback = ReturnType<typeof createPreviewPlayback>;

let page: PreviewPlayback | null = null;

/** The page's preview, created on first use with a real `Audio` element. */
export const audioPreview = (): PreviewPlayback => {
  page ??= createPreviewPlayback({
    createAudio: () => new Audio() as PreviewAudioElement,
  });

  return page;
};
