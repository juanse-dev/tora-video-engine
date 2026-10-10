/**
 * In-memory OPFS root for Node tests (issue #29).
 *
 * It models the one Chrome behaviour that matters for render cleanup: while a
 * `FileSystemWritableFileStream` is open (neither closed nor aborted), the file
 * cannot be removed and `removeEntry` rejects with `NoModificationAllowedError`.
 * `close()` commits the written bytes; `abort()` discards them. The writable is
 * a real `WritableStream`, so a locked stream (someone holds `getWriter()`)
 * rejects `abort()` with a `TypeError` exactly like the platform does.
 *
 * Public API:
 * - `files`: Map name -> `{bytes, writable}`; `writable.state` is
 *   `"open" | "closed" | "aborted"`.
 * - `events`: ordered log of `create:<name>`, `close:<name>`, `abort:<name>`.
 * - `getDirectory()`: async accessor returning the fake root, which has
 *   `getFileHandle`, `removeEntry` and `entries`.
 * - option `abortRejects`: the sink's abort throws (best-effort abort tests).
 * - options `writeFails` / `closeFails`: `write()` / `close()` reject with an
 *   Error (not an abort), leaving the file open.
 * - option `writeGate`: a promise every `write()` awaits before it checks the
 *   state, so a test can abort the writable while a write is in flight.
 */
class FakeWritable extends WritableStream {
  constructor(name, file, events, options) {
    const self = {state: "open"};

    super({
      write(chunk) {
        const {data, position} = chunk;
        const needed = position + data.byteLength;

        if (needed > file.pending.byteLength) {
          const grown = new Uint8Array(needed);

          grown.set(file.pending);
          file.pending = grown;
        }

        file.pending.set(data, position);
      },
      close() {
        if (options.closeFails === true) {
          throw new Error("close failed");
        }

        self.state = "closed";
        file.bytes = file.pending;
        events.push(`close:${name}`);
      },
      abort() {
        self.state = "aborted";
        events.push(`abort:${name}`);

        if (options.abortRejects === true) {
          throw new Error("abort failed");
        }
      },
    });

    Object.defineProperty(this, "state", {get: () => self.state});

    // A stream that already errored (for example a failed close) ignores the
    // sink's abort. Record the caller's abort request anyway, as the platform
    // releases the file when the owner aborts it.
    const nativeAbort = this.abort.bind(this);

    this.abort = async (reason) => {
      try {
        return await nativeAbort(reason);
      } finally {
        if (self.state === "open") {
          self.state = "aborted";
          events.push(`abort:${name}`);
        }
      }
    };
    this.writeGate = options.writeGate;
    this.writeFails = options.writeFails;
  }

  // FileSystemWritableFileStream.write(): the convenience writer that takes the
  // lock for the duration of one write.
  async write(chunk) {
    if (this.writeGate !== undefined) {
      await this.writeGate;
    }

    if (this.state !== "open") {
      throw new TypeError("writable is not open");
    }

    if (this.writeFails === true) {
      throw new Error("write failed");
    }

    const writer = this.getWriter();

    try {
      await writer.write(chunk);
    } finally {
      writer.releaseLock();
    }
  }
}

export const createFakeOpfs = (options = {}) => {
  const files = new Map();
  const events = [];

  const root = {
    async getFileHandle(name, {create = false} = {}) {
      let file = files.get(name);

      if (file === undefined) {
        if (!create) {
          throw new DOMException("not found", "NotFoundError");
        }

        file = {
          bytes: new Uint8Array(0),
          pending: new Uint8Array(0),
          writable: null,
        };
        files.set(name, file);
        events.push(`create:${name}`);
      }

      return {
        name,
        async createWritable() {
          file.pending = new Uint8Array(0);
          file.writable = new FakeWritable(name, file, events, options);

          return file.writable;
        },
        async getFile() {
          return new Blob([file.bytes], {type: ""});
        },
      };
    },
    async removeEntry(name) {
      const file = files.get(name);

      if (file === undefined) {
        throw new DOMException("not found", "NotFoundError");
      }

      if (file.writable !== null && file.writable.state === "open") {
        throw new DOMException(
          "An attempt was made to modify an object where modifications are not allowed.",
          "NoModificationAllowedError",
        );
      }

      files.delete(name);
    },
    async *entries() {
      for (const name of [...files.keys()]) {
        yield [name, {}];
      }
    },
  };

  return {files, events, getDirectory: async () => root};
};
