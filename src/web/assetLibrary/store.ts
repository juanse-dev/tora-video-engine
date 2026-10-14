import type {
  ImagePayloadMetadata,
  PayloadMetadata,
} from "../../localAssets/readiness.ts";
import type {
  ImageAssetCategory,
  LocalImageRef,
} from "../../localAssets/refs.ts";
import type {AssetRow, Decoded, ThumbnailRecord} from "./records.ts";

export type AssetPageCursor = {after?: LocalImageRef; before?: LocalImageRef};

export type AssetLibraryMutation =
  | {
      kind: "import";
      ref: LocalImageRef;
      defaultLabel: string;
      originalFilename: string;
      createdAt: string;
      payloadMeta: ImagePayloadMetadata;
      blob: Blob;
      thumbnail: ThumbnailRecord;
    }
  | {kind: "rename"; ref: LocalImageRef; label: string}
  | {kind: "delete"; ref: LocalImageRef};

export type AssetLibraryMutationResult =
  | {kind: "imported"; ref: LocalImageRef; created: boolean} // created=false: existing row reused/repaired
  | {kind: "renamed"; ref: LocalImageRef}
  | {kind: "deleted"; ref: LocalImageRef; payloadRemoved: boolean}
  | {kind: "not-found"; ref: LocalImageRef}; // rename/delete of a row that no longer exists

export type LocalAssetLibraryErrorCode = "storage-full" | "storage-error";

/**
 * Storage failure from a store adapter. The import pipeline classifies it by
 * `code`; the name is deliberately not "QuotaExceededError" (that name belongs
 * to the DOMException the browser raises, which callers may still see from
 * other stores).
 */
export class LocalAssetLibraryError extends Error {
  code: LocalAssetLibraryErrorCode;

  constructor(
    code: LocalAssetLibraryErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "LocalAssetLibraryError";
    this.code = code;

    if (cause !== undefined) {
      (this as {cause?: unknown}).cause = cause;
    }
  }
}

export interface AssetLibraryStore {
  getAssetRow(ref: LocalImageRef): Promise<Decoded<AssetRow>>;
  getPayloadMeta(digest: string): Promise<Decoded<PayloadMetadata>>;
  getBlob(digest: string): Promise<Decoded<Blob>>;
  getThumbnail(digest: string): Promise<Decoded<ThumbnailRecord>>;
  /**
   * Ordered by primary key inside the category prefix; at most `limit` rows.
   * Keys that are not canonical refs of `category` are skipped and never count
   * toward `limit`. With `cursor.before` set: the last `limit` rows whose key is
   * `< before`, returned in ascending order. Otherwise: the first `limit` rows
   * whose key is `> after` (or from the start of the category).
   */
  listAssets(
    category: ImageAssetCategory,
    cursor: AssetPageCursor,
    limit: number,
  ): Promise<Array<{ref: LocalImageRef; row: Decoded<AssetRow>}>>;
  countAssets(category: ImageAssetCategory): Promise<number>;
  /** Applies one mutation in ONE read-write transaction over all four stores. */
  apply(mutation: AssetLibraryMutation): Promise<AssetLibraryMutationResult>;
  close(): void;
}
