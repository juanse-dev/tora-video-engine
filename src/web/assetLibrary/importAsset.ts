import {sha256Hex} from "../../localAssets/hash.ts";
import {
  checkLocalAssetByteSize,
  describeImageRejection,
  inspectImageBytes,
} from "../../localAssets/imageInspection.ts";
import type {ImagePayloadMetadata} from "../../localAssets/readiness.ts";
import {
  buildLocalAssetRef,
  type ImageAssetCategory,
  type LocalAssetCategory,
  type LocalAssetRef,
  type LocalAudioRef,
  type LocalImageRef,
} from "../../localAssets/refs.ts";
import {
  requestPersistentStorageOnce,
  withAssetLibraryLock,
  type AssetLibraryMessage,
} from "./coordination.ts";
import {
  buildDefaultLabel,
  LocalAssetImportError,
  type ImportPhase,
  type LocalAssetImportErrorCode,
} from "./importCommon.ts";
import {
  prepareLocalAudioImport,
  type PreparedLocalAudioImport,
  type PrepareLocalAudioImportDeps,
} from "./importAudio.ts";
import type {ThumbnailRecord} from "./records.ts";
import {LocalAssetLibraryError, type AssetLibraryStore} from "./store.ts";
import {createThumbnail} from "./thumbnails.ts";

export {LocalAssetImportError};
export type {ImportPhase, LocalAssetImportErrorCode};

export type PreparedLocalImageImport = {
  ref: LocalImageRef;
  defaultLabel: string;
  originalFilename: string;
  payloadMeta: ImagePayloadMetadata;
  blob: Blob;
  thumbnail: ThumbnailRecord;
};

export type {PreparedLocalAudioImport};
export type PreparedLocalAssetImport =
  | PreparedLocalImageImport
  | PreparedLocalAudioImport;

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
} & Pick<PrepareLocalAudioImportDeps, "inspectAudio" | "decodePeaks">;

type ImportLibrary = {
  store: AssetLibraryStore;
  locks: LockManager;
  channel: {post(message: AssetLibraryMessage): void};
};

/** Browser default; Node tests inject `decode` and never reach this. */
const decodeWithBrowser = (blob: Blob) => createImageBitmap(blob);

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
const prepareLocalImageImport = async (
  file: File,
  category: ImageAssetCategory,
  deps: PrepareLocalAssetImportDeps = {},
): Promise<PreparedLocalImageImport> => {
  // 1. Bound the size before any bytes are read.
  const size = checkLocalAssetByteSize(file.size, category);

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

export function prepareLocalAssetImport(
  file: File,
  category: ImageAssetCategory,
  deps?: PrepareLocalAssetImportDeps,
): Promise<PreparedLocalImageImport>;
export function prepareLocalAssetImport(
  file: File,
  category: "audio",
  deps?: PrepareLocalAssetImportDeps,
): Promise<PreparedLocalAudioImport>;
export function prepareLocalAssetImport(
  file: File,
  category: LocalAssetCategory,
  deps?: PrepareLocalAssetImportDeps,
): Promise<PreparedLocalAssetImport>;
export function prepareLocalAssetImport(
  file: File,
  category: LocalAssetCategory,
  deps: PrepareLocalAssetImportDeps = {},
): Promise<PreparedLocalAssetImport> {
  return category === "audio"
    ? prepareLocalAudioImport(file, deps)
    : prepareLocalImageImport(file, category, deps);
}

const isStorageFull = (error: unknown): boolean =>
  (error instanceof LocalAssetLibraryError && error.code === "storage-full") ||
  (error as {name?: unknown} | null)?.name === "QuotaExceededError";

const toStorageError = (
  error: unknown,
  noun: "image" | "audio file",
): LocalAssetImportError =>
  isStorageFull(error)
    ? new LocalAssetImportError(
        "storage-full",
        `There is not enough browser storage left for this ${noun}.`,
        {cause: error},
      )
    : new LocalAssetImportError(
        "storage-error",
        `The ${noun} could not be saved to browser storage.`,
        {cause: error},
      );

export type CommitPreparedLocalAssetImportDeps = {
  storage?: StorageManager;
  /**
   * Cancels the commit only while it is still waiting for the exclusive lock
   * (it rejects with a "cancelled" LocalAssetImportError and writes nothing).
   * Once the lock is granted the IndexedDB transaction is short and atomic, so
   * the signal is ignored and the import finishes.
   */
  signal?: AbortSignal;
  /** Called when the lock is granted, right before the transaction starts: cancelling is over. */
  onLockAcquired?: () => void;
};

/**
 * Commits an already-prepared import under the exclusive lock and posts the
 * change message. The Story is never touched here.
 */
export function commitPreparedLocalAssetImport(
  prepared: PreparedLocalImageImport,
  library: ImportLibrary,
  deps?: CommitPreparedLocalAssetImportDeps,
): Promise<{ref: LocalImageRef; created: boolean}>;
export function commitPreparedLocalAssetImport(
  prepared: PreparedLocalAudioImport,
  library: ImportLibrary,
  deps?: CommitPreparedLocalAssetImportDeps,
): Promise<{ref: LocalAudioRef; created: boolean}>;
export function commitPreparedLocalAssetImport(
  prepared: PreparedLocalAssetImport,
  library: ImportLibrary,
  deps?: CommitPreparedLocalAssetImportDeps,
): Promise<{ref: LocalAssetRef; created: boolean}>;
export async function commitPreparedLocalAssetImport(
  prepared: PreparedLocalAssetImport,
  library: ImportLibrary,
  deps?: CommitPreparedLocalAssetImportDeps,
): Promise<{ref: LocalAssetRef; created: boolean}> {
  const noun = "waveform" in prepared ? "audio file" : "image";
  let result;
  let lockAcquired = false;

  try {
    result = await withAssetLibraryLock(
      library.locks,
      "exclusive",
      () => {
        lockAcquired = true;
        deps?.onLockAcquired?.();

        const createdAt = new Date().toISOString();

        return library.store.apply(
          "waveform" in prepared
            ? {
                kind: "import-audio",
                ref: prepared.ref,
                defaultLabel: prepared.defaultLabel,
                originalFilename: prepared.originalFilename,
                createdAt,
                payloadMeta: prepared.payloadMeta,
                blob: prepared.blob,
                waveform: prepared.waveform,
              }
            : {
                kind: "import",
                ref: prepared.ref,
                defaultLabel: prepared.defaultLabel,
                originalFilename: prepared.originalFilename,
                createdAt,
                payloadMeta: prepared.payloadMeta,
                blob: prepared.blob,
                thumbnail: prepared.thumbnail,
              },
        );
      },
      deps?.signal === undefined ? undefined : {signal: deps.signal},
    );
  } catch (error) {
    // A rejection while the lock was never granted and the signal is aborted is
    // our own cancel. After the grant an AbortError can only come from the
    // store (an aborted transaction): that stays a storage error.
    if (!lockAcquired && deps?.signal?.aborted === true) {
      throw new LocalAssetImportError("cancelled", "Import cancelled.", {
        cause: error,
      });
    }

    throw toStorageError(error, noun);
  }

  if (result.kind !== "imported") {
    throw new LocalAssetImportError(
      "storage-error",
      `The ${noun} could not be saved to browser storage.`,
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

  return {ref: prepared.ref, created: result.created};
}

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
