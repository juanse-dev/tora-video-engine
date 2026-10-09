import {inspectImageBytes} from "../../localAssets/imageInspection.ts";
import {
  parseLocalAssetRef,
  type LocalAssetCategory,
  type LocalAssetRef,
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
import type {AssetRow, Decoded} from "./records.ts";
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

const mutateLibrary = async (
  library: AssetLibrary,
  mutation: AssetLibraryMutation,
): Promise<AssetLibraryMutationResult> => {
  const result = await withAssetLibraryLock(library.locks, "exclusive", () =>
    library.store.apply(mutation),
  );

  if (result.kind !== "not-found") {
    const parsed = parseLocalAssetRef(mutation.ref);

    try {
      library.channel.post({
        type: "asset-library-changed",
        refs: [mutation.ref],
        digests: parsed === null ? [] : [parsed.digest],
      });
    } catch {
      // The channel is a best-effort refresh signal; the mutation succeeded.
    }
  }

  return result;
};

/** Normalizes the label (trim, non-empty, length); rejects with an Error if it is invalid. */
export const renameLocalAsset = (
  library: AssetLibrary,
  ref: LocalAssetRef,
  label: string,
): Promise<AssetLibraryMutationResult> => {
  const normalized = normalizeLocalAssetLabel(label);

  if (!normalized.ok) {
    return Promise.reject(new Error(normalized.message));
  }

  return mutateLibrary(library, {kind: "rename", ref, label: normalized.label});
};

export const deleteLocalAsset = (
  library: AssetLibrary,
  ref: LocalAssetRef,
): Promise<AssetLibraryMutationResult> =>
  mutateLibrary(library, {kind: "delete", ref});

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
