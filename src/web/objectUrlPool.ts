import type {LocalAssetUrlPool} from "./localAssetState.ts";

type PoolEntry = {url: string; holders: number};

/**
 * Ref-counted `digest -> blob: URL` pool. Every holder (the preview state, each
 * in-flight render) acquires the digests it uses and releases them when done;
 * the URL is revoked when the last holder releases it.
 */
export class ObjectUrlPool implements LocalAssetUrlPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly create: (blob: Blob) => string;
  private readonly revoke: (url: string) => void;

  constructor(deps?: {
    create?: (blob: Blob) => string;
    revoke?: (url: string) => void;
  }) {
    this.create = deps?.create ?? ((blob) => URL.createObjectURL(blob));
    this.revoke = deps?.revoke ?? ((url) => URL.revokeObjectURL(url));
  }

  /** Returns the existing URL for digest or creates one; increments its holder count. */
  acquire(digest: string, blob: Blob): string {
    const existing = this.entries.get(digest);

    if (existing !== undefined) {
      existing.holders += 1;

      return existing.url;
    }

    const url = this.create(blob);

    this.entries.set(digest, {url, holders: 1});

    return url;
  }

  /** Decrements; revokes the URL when the count reaches 0. Unknown digests are ignored. */
  release(digest: string): void {
    const entry = this.entries.get(digest);

    if (entry === undefined) {
      return;
    }

    entry.holders -= 1;

    if (entry.holders <= 0) {
      this.entries.delete(digest);
      this.revoke(entry.url);
    }
  }

  /** Revokes everything (app teardown). */
  dispose(): void {
    const urls = [...this.entries.values()].map((entry) => entry.url);

    this.entries.clear();

    for (const url of urls) {
      this.revoke(url);
    }
  }
}
