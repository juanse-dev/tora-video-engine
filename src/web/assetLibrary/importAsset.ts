import {sha256Hex} from "../../localAssets/hash.ts";
import {
  checkLocalAssetByteSize,
  describeImageRejection,
  inspectImageBytes,
  type ImageRejection,
} from "../../localAssets/imageInspection.ts";
import type {PayloadMetadata} from "../../localAssets/readiness.ts";
import {
  buildLocalAssetRef,
  type LocalAssetCategory,
  type LocalAssetRef,
} from "../../localAssets/refs.ts";
import {MAX_LOCAL_ASSET_LABEL_LENGTH} from "./constants.ts";
import {
  requestPersistentStorageOnce,
  withAssetLibraryLock,
  type AssetLibraryMessage,
} from "./coordination.ts";
import type {ThumbnailRecord} from "./records.ts";
import type {AssetLibraryStore} from "./store.ts";
import {createThumbnail} from "./thumbnails.ts";

export type ImportPhase = "reading" | "validating" | "hashing" | "storing";

export type LocalAssetImportErrorCode =
  | ImageRejection
  | "decode-failed"
  | "thumbnail-failed"
  | "storage-full"
  | "storage-error";

export class LocalAssetImportError extends Error {
  code: LocalAssetImportErrorCode;
  cause?: unknown;

  constructor(
    code: LocalAssetImportErrorCode,
    message: string,
    options?: {cause?: unknown},
  ) {
    super(message);
    this.name = "LocalAssetImportError";
    this.code = code;

    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export type PreparedLocalAssetImport = {
  ref: LocalAssetRef;
  defaultLabel: string;
  originalFilename: string;
  payloadMeta: PayloadMetadata;
  blob: Blob;
  thumbnail: ThumbnailRecord;
};

export type PrepareLocalAssetImportDeps = {
  subtle?: SubtleCrypto;
  decode?: (
    blob: Blob,
  ) => Promise<{width: number; height: number; close(): void}>;
  makeThumbnail?: (
    blob: Blob,
    width: number,
    height: number,
  ) => Promise<ThumbnailRecord>;
  onPhase?: (phase: ImportPhase) => void;
};

type ImportLibrary = {
  store: AssetLibraryStore;
  locks: LockManager;
  channel: {post(message: AssetLibraryMessage): void};
};

/** Browser default; Node tests inject `decode` and never reach this. */
const decodeWithBrowser = (blob: Blob) => createImageBitmap(blob);

/**
 * D-12: filename without its last extension, trimmed, cut to the label limit in
 * code points; falls back to "Untitled <category>" when nothing is left.
 */
const buildDefaultLabel = (
  filename: string,
  category: LocalAssetCategory,
): string => {
  const dot = filename.lastIndexOf(".");
  const stem = dot === -1 ? filename : filename.slice(0, dot);
  const label = Array.from(stem.trim())
    .slice(0, MAX_LOCAL_ASSET_LABEL_LENGTH)
    .join("")
    .trim();

  return label === "" ? `Untitled ${category}` : label;
};

const isSameOrSwappedSize = (
  decoded: {width: number; height: number},
  header: {width: number; height: number},
): boolean =>
  (decoded.width === header.width && decoded.height === header.height) ||
  (decoded.width === header.height && decoded.height === header.width);

/**
 * Everything that can fail before a write: size check, read, header
 * inspection, hashing, decode check and thumbnail. Takes no lock and writes
 * nothing. Throws LocalAssetImportError.
 */
export const prepareLocalAssetImport = async (
  file: File,
  category: LocalAssetCategory,
  deps: PrepareLocalAssetImportDeps = {},
): Promise<PreparedLocalAssetImport> => {
  // 1. Bound the size before any bytes are read.
  const size = checkLocalAssetByteSize(file.size);

  if (!size.ok) {
    throw new LocalAssetImportError(
      size.reason,
      describeImageRejection(size.reason),
    );
  }

  // 2. Read.
  deps.onPhase?.("reading");

  let bytes: Uint8Array;

  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    throw new LocalAssetImportError(
      "malformed",
      "The file could not be read.",
      {cause: error},
    );
  }

  // 3. Header inspection (INV-7).
  deps.onPhase?.("validating");

  const inspection = inspectImageBytes(bytes);

  if (!inspection.ok) {
    throw new LocalAssetImportError(
      inspection.reason,
      describeImageRejection(inspection.reason),
    );
  }

  const {image} = inspection;

  // 4. Identity (INV-3): hash of the original bytes.
  deps.onPhase?.("hashing");

  let digest: string;

  try {
    digest = await sha256Hex(bytes, deps.subtle);
  } catch (error) {
    // An environment failure (for example no SubtleCrypto), not a file problem.
    throw new LocalAssetImportError(
      "storage-error",
      "The image could not be fingerprinted in this browser.",
      {cause: error},
    );
  }

  const ref = buildLocalAssetRef(category, digest);
  const blob = new Blob([bytes as BlobPart], {type: image.mimeType});

  // 5. Decode check. Browsers apply EXIF rotation with no opt-out, so a
  // swapped size is as good as the header size.
  let decoded: {width: number; height: number; close(): void};

  try {
    decoded = await (deps.decode ?? decodeWithBrowser)(blob);
  } catch (error) {
    throw new LocalAssetImportError(
      "decode-failed",
      "The browser could not decode this image.",
      {cause: error},
    );
  }

  try {
    if (!isSameOrSwappedSize(decoded, image)) {
      throw new LocalAssetImportError(
        "decode-failed",
        "The decoded image size does not match the file header.",
      );
    }
  } finally {
    decoded.close();
  }

  // 6. Thumbnail (separate derivative; the original is never resized, INV-6).
  let thumbnail: ThumbnailRecord;

  try {
    thumbnail = await (deps.makeThumbnail ?? createThumbnail)(
      blob,
      image.width,
      image.height,
    );
  } catch (error) {
    throw new LocalAssetImportError(
      "thumbnail-failed",
      "A preview could not be created for this image.",
      {cause: error},
    );
  }

  // 7. Result.
  return {
    ref,
    defaultLabel: buildDefaultLabel(file.name, category),
    originalFilename: file.name,
    payloadMeta: {
      mimeType: image.mimeType,
      byteSize: bytes.length,
      width: image.width,
      height: image.height,
    },
    blob,
    thumbnail,
  };
};

const toStorageError = (error: unknown): LocalAssetImportError =>
  error instanceof Error && error.name === "QuotaExceededError"
    ? new LocalAssetImportError(
        "storage-full",
        "There is not enough browser storage left for this image.",
        {cause: error},
      )
    : new LocalAssetImportError(
        "storage-error",
        "The image could not be saved to browser storage.",
        {cause: error},
      );

/**
 * Commits an already-prepared import under the exclusive lock and posts the
 * change message. The Story is never touched here.
 */
export const commitPreparedLocalAssetImport = async (
  prepared: PreparedLocalAssetImport,
  library: ImportLibrary,
  deps?: {storage?: StorageManager},
): Promise<{ref: LocalAssetRef; created: boolean}> => {
  let result;

  try {
    result = await withAssetLibraryLock(library.locks, "exclusive", () =>
      library.store.apply({
        kind: "import",
        ref: prepared.ref,
        defaultLabel: prepared.defaultLabel,
        originalFilename: prepared.originalFilename,
        createdAt: new Date().toISOString(),
        payloadMeta: prepared.payloadMeta,
        blob: prepared.blob,
        thumbnail: prepared.thumbnail,
      }),
    );
  } catch (error) {
    throw toStorageError(error);
  }

  if (result.kind !== "imported") {
    throw new LocalAssetImportError(
      "storage-error",
      "The image could not be saved to browser storage.",
    );
  }

  try {
    library.channel.post({
      type: "asset-library-changed",
      refs: [prepared.ref],
      digests: [prepared.ref.slice(prepared.ref.lastIndexOf(":") + 1)],
    });
  } catch {
    // The channel is a best-effort refresh signal; the import succeeded.
  }

  // Fire and forget: persist() can sit on a permission prompt (Firefox) and
  // must never delay a successful import. It never rejects.
  void requestPersistentStorageOnce(deps);

  return {ref: result.ref, created: result.created};
};

/** prepareLocalAssetImport + onPhase("storing") + commitPreparedLocalAssetImport. */
export const importLocalAsset = async (
  file: File,
  category: LocalAssetCategory,
  library: ImportLibrary,
  deps: PrepareLocalAssetImportDeps & {storage?: StorageManager} = {},
): Promise<{ref: LocalAssetRef; created: boolean}> => {
  const prepared = await prepareLocalAssetImport(file, category, deps);

  deps.onPhase?.("storing");

  return commitPreparedLocalAssetImport(prepared, library, deps);
};
