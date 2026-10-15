import type {AudioDurationMap} from "../../audio/catalog.ts";
import {inspectImageBytes} from "../../localAssets/imageInspection.ts";
import {
  isAudioPayload,
  type AudioPayloadMetadata,
} from "../../localAssets/readiness.ts";
import {
  parseLocalAssetRef,
  type LocalAssetCategory,
  type LocalAssetRef,
  type LocalAudioRef,
} from "../../localAssets/refs.ts";
import {
  LOCAL_ASSET_PAGE_SIZE,
  MAX_LOCAL_ASSET_LABEL_LENGTH,
  MAX_THUMBNAIL_DIMENSION,
  THUMBNAIL_MIME_TYPES,
} from "./constants.ts";
import {
  withAssetLibraryLock,
  type AssetLibraryMessage,
} from "./coordination.ts";
import type {AssetRow, Decoded, WaveformRecord} from "./records.ts";
import type {
  AssetLibraryMutation,
  AssetLibraryMutationResult,
  AssetLibraryStore,
  AssetPageCursor,
} from "./store.ts";

export type LocalAssetEntry = {
  ref: LocalAssetRef;
  category: LocalAssetCategory;
  digest: string;
  row: Decoded<AssetRow>; // corrupt rows are listed so they can be repaired/deleted, never applied
};

export type AssetLibrary = {
  store: AssetLibraryStore;
  locks: LockManager;
  channel: {post(message: AssetLibraryMessage): void};
};

// The opposite-direction flag is inferred from the cursor, so callers must handle an empty page.
export const listLocalAssetPage = async (
  store: AssetLibraryStore,
  category: LocalAssetCategory,
  cursor: AssetPageCursor = {},
): Promise<{
  entries: LocalAssetEntry[];
  hasPrevious: boolean;
  hasNext: boolean;
}> => {
  const rows = await store.listAssets(
    category,
    cursor,
    LOCAL_ASSET_PAGE_SIZE + 1,
  );
  const overflow = rows.length > LOCAL_ASSET_PAGE_SIZE;
  const goingBack = cursor.before !== undefined;
  // The extra row is the one furthest from the cursor.
  const visible = overflow
    ? goingBack
      ? rows.slice(rows.length - LOCAL_ASSET_PAGE_SIZE)
      : rows.slice(0, LOCAL_ASSET_PAGE_SIZE)
    : rows;
  const entries: LocalAssetEntry[] = [];

  for (const {ref, row} of visible) {
    const parsed = parseLocalAssetRef(ref);

    // Stores must only return canonical refs; ignore anything else defensively.
    if (parsed === null || parsed.category !== category) {
      continue;
    }

    entries.push({ref, category, digest: parsed.digest, row});
  }

  return {
    entries,
    hasPrevious: goingBack ? overflow : cursor.after !== undefined,
    hasNext: goingBack ? true : overflow,
  };
};

export const countLocalAssets = (
  store: AssetLibraryStore,
  category: LocalAssetCategory,
): Promise<number> => store.countAssets(category);

export const normalizeLocalAssetLabel = (
  label: string,
): {ok: true; label: string} | {ok: false; message: string} => {
  const trimmed = label.trim();

  if (trimmed === "") {
    return {ok: false, message: "Enter a name for this asset."};
  }

  if (Array.from(trimmed).length > MAX_LOCAL_ASSET_LABEL_LENGTH) {
    return {
      ok: false,
      message: `Names can be at most ${MAX_LOCAL_ASSET_LABEL_LENGTH} characters.`,
    };
  }

  return {ok: true, label: trimmed};
};

/** Rejection of a rename/delete whose wait for the library lock was cancelled; nothing was written. */
export class LocalAssetMutationCancelledError extends Error {
  cause?: unknown;

  constructor(options?: {cause?: unknown}) {
    super("The change was cancelled before it started.");
    this.name = "LocalAssetMutationCancelledError";

    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export type LibraryMutationOptions = {
  /**
   * Cancels the change only while it is still waiting for the exclusive lock
   * (it rejects with a LocalAssetMutationCancelledError and writes nothing).
   * Once the lock is granted the transaction is short and atomic, so the
   * signal is ignored and the change finishes.
   */
  signal?: AbortSignal;
  /** Called once when the lock is granted, right before the transaction starts: cancelling is over. */
  onLockAcquired?: () => void;
};

// `invalidatesPayload`: false for a label-only change. The message then names no
// digests, so tabs keep their verified payloads (no re-hash) and only refresh.
const mutateLibrary = async (
  library: AssetLibrary,
  mutation: AssetLibraryMutation,
  invalidatesPayload: boolean,
  options?: LibraryMutationOptions,
): Promise<AssetLibraryMutationResult> => {
  let lockAcquired = false;
  let result: AssetLibraryMutationResult;

  try {
    result = await withAssetLibraryLock(
      library.locks,
      "exclusive",
      () => {
        lockAcquired = true;
        options?.onLockAcquired?.();

        return library.store.apply(mutation);
      },
      options?.signal === undefined ? undefined : {signal: options.signal},
    );
  } catch (error) {
    // A rejection while the lock was never granted and the signal is aborted is
    // our own cancel. After the grant an AbortError can only come from the
    // store (an aborted transaction): that stays a storage error.
    if (!lockAcquired && options?.signal?.aborted === true) {
      throw new LocalAssetMutationCancelledError({cause: error});
    }

    throw error;
  }

  if (result.kind !== "not-found") {
    const parsed = parseLocalAssetRef(mutation.ref);

    try {
      library.channel.post({
        type: "asset-library-changed",
        refs: [mutation.ref],
        digests: parsed === null || !invalidatesPayload ? [] : [parsed.digest],
      });
    } catch {
      // The channel is a best-effort refresh signal; the mutation succeeded.
    }
  }

  return result;
};

/**
 * Normalizes the label (trim, non-empty, length); rejects with an Error if it is invalid.
 * `options` can cancel the wait for the lock (see LibraryMutationOptions).
 */
export const renameLocalAsset = (
  library: AssetLibrary,
  ref: LocalAssetRef,
  label: string,
  options?: LibraryMutationOptions,
): Promise<AssetLibraryMutationResult> => {
  const normalized = normalizeLocalAssetLabel(label);

  if (!normalized.ok) {
    return Promise.reject(new Error(normalized.message));
  }

  return mutateLibrary(
    library,
    {kind: "rename", ref, label: normalized.label},
    false,
    options,
  );
};

/** `options` can cancel the wait for the lock (see LibraryMutationOptions). */
export const deleteLocalAsset = (
  library: AssetLibrary,
  ref: LocalAssetRef,
  options?: LibraryMutationOptions,
): Promise<AssetLibraryMutationResult> =>
  mutateLibrary(library, {kind: "delete", ref}, true, options);

/**
 * The stored metadata of a local audio ref, or null when the ref is not usable:
 * its row is absent or corrupt, or its metadata is absent, corrupt or not audio.
 * The ref is the key; nothing stored redirects it (INV-11).
 */
export const readAudioMetadata = async (
  store: Pick<AssetLibraryStore, "getAssetRow" | "getPayloadMeta">,
  ref: LocalAudioRef,
): Promise<AudioPayloadMetadata | null> => {
  const parsed = parseLocalAssetRef(ref);

  if (parsed === null) {
    return null;
  }

  const row = await store.getAssetRow(ref);

  if (row.status !== "present") {
    return null;
  }

  const meta = await store.getPayloadMeta(parsed.digest);

  return meta.status === "present" && isAudioPayload(meta.value)
    ? meta.value
    : null;
};

/** The waveform stored under `digest`, or null when absent or corrupt. */
export const readWaveform = async (
  store: Pick<AssetLibraryStore, "getWaveform">,
  digest: string,
): Promise<WaveformRecord | null> => {
  const record = await store.getWaveform(digest);

  return record.status === "present" ? record.value : null;
};

/**
 * The durations of exactly these refs (the Story's refs, never the visible
 * library page, which holds LOCAL_ASSET_PAGE_SIZE rows at a time). Refs that are
 * absent stay out of the map (they remain `missing`); a duration that is not
 * finite and greater than 0 never enters it.
 */
export const readAudioDurations = async (
  store: Pick<AssetLibraryStore, "getAssetRow" | "getPayloadMeta">,
  refs: Iterable<LocalAudioRef>,
): Promise<AudioDurationMap> => {
  const durations: Partial<Record<LocalAudioRef, number>> = {};

  for (const ref of new Set(refs)) {
    const metadata = await readAudioMetadata(store, ref);

    if (
      metadata !== null &&
      Number.isFinite(metadata.durationSeconds) &&
      metadata.durationSeconds > 0
    ) {
      durations[ref] = metadata.durationSeconds;
    }
  }

  return durations;
};

/**
 * Record metadata does not bound what the Blob really encodes, so the bytes are
 * inspected before the caller may create an object URL (at most 512 KiB, cheap).
 */
export const loadThumbnailForDisplay = async (
  store: AssetLibraryStore,
  digest: string,
): Promise<{ok: true; blob: Blob} | {ok: false}> => {
  const decoded = await store.getThumbnail(digest);

  if (decoded.status !== "present") {
    return {ok: false};
  }

  const {blob, width, height} = decoded.value;
  let bytes: Uint8Array;

  try {
    bytes = new Uint8Array(await blob.arrayBuffer());
  } catch {
    return {ok: false};
  }

  const inspected = inspectImageBytes(bytes);

  if (
    !inspected.ok ||
    !(THUMBNAIL_MIME_TYPES as readonly string[]).includes(
      inspected.image.mimeType,
    ) ||
    inspected.image.width > MAX_THUMBNAIL_DIMENSION ||
    inspected.image.height > MAX_THUMBNAIL_DIMENSION ||
    inspected.image.width !== width ||
    inspected.image.height !== height
  ) {
    return {ok: false};
  }

  // The stored Blob.type is untrusted; hand out a handle typed by the bytes.
  return {ok: true, blob: blob.slice(0, blob.size, inspected.image.mimeType)};
};
