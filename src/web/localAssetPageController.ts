import type {
  LocalAssetCategory,
  LocalAssetRef,
} from "../localAssets/refs.ts";
import {parseLocalAssetRef} from "../localAssets/refs.ts";
import type {AssetPageCursor, AssetLibraryStore} from "./assetLibrary/store.ts";
import {
  countLocalAssets,
  listLocalAssetPage,
  loadThumbnailForDisplay,
  type LocalAssetEntry,
} from "./assetLibrary/library.ts";
import {ObjectUrlPool} from "./objectUrlPool.ts";

export type LocalAssetPageEntry = LocalAssetEntry & {
  thumbnailUrl: string | null;
};

/** State of the pinned (currently selected) ref, which may not be on the visible page. */
export type PinnedLocalAsset =
  | {kind: "none"} // nothing pinned
  | {kind: "loading"}
  | {kind: "missing"} // no row for the ref in this library
  | {kind: "error"} // reading the ref failed (the page load failed)
  | {kind: "present"; entry: LocalAssetPageEntry}; // entry.row may be corrupt

export type LocalAssetPageSnapshot = {
  entries: LocalAssetPageEntry[];
  total: number;
  hasPrevious: boolean;
  hasNext: boolean;
  loading: boolean;
  /** True once a load has settled; before that an empty list is not yet "no assets". */
  loaded: boolean;
  /** Set when the last load failed; the previous page (if any) is kept. */
  error: string | null;
  /** The ref that `pinned` describes, so a stale state is never shown for a newer ref. */
  pinnedFor: LocalAssetRef | null;
  pinned: PinnedLocalAsset;
};

export const LOCAL_ASSET_LOAD_ERROR = "Could not load My assets.";

type ThumbnailResult = {ok: true; blob: Blob} | {ok: false};

export const EMPTY_LOCAL_ASSET_PAGE: LocalAssetPageSnapshot = {
  entries: [],
  total: 0,
  hasPrevious: false,
  hasNext: false,
  loading: false,
  loaded: false,
  error: null,
  pinnedFor: null,
  pinned: {kind: "none"},
};

/**
 * Framework-free paging state for one category of My assets: one page of rows
 * (at most LOCAL_ASSET_PAGE_SIZE), the total, the pinned current ref, and the
 * thumbnails of the visible rows only.
 *
 * - Thumbnails come only from `loadThumbnailForDisplay`; blobs are never read.
 * - Object URLs are created for the visible page (plus the pinned ref) and
 *   revoked as soon as their digest is no longer visible, and on dispose.
 * - Every load supersedes the previous one; a superseded load creates no URL.
 * - Paging is a stack of "after" cursors, so stepping back (or backing off an
 *   emptied page) re-reads the same boundaries.
 * - next()/previous() are ignored while a load is pending (the snapshot would
 *   still describe the old page), so a double click advances one page.
 * - A failed load sets `error`, keeps the previous page and restores the last
 *   committed cursor, so the same action can be retried. If the pinned ref was
 *   not loaded yet, `pinned` becomes `{kind: "error"}` (never stuck loading).
 * - `pinnedFor` names the ref `pinned` describes; while a newly pinned ref is
 *   loading, `pinned` is `{kind: "loading"}` for that ref.
 */
export const createLocalAssetPageController = (options: {
  store: Pick<
    AssetLibraryStore,
    "listAssets" | "countAssets" | "getAssetRow" | "getThumbnail"
  >;
  category: LocalAssetCategory;
  loadThumbnail?: (digest: string) => Promise<ThumbnailResult>;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
}) => {
  const {store, category} = options;
  const loadThumbnail =
    options.loadThumbnail ??
    ((digest: string) =>
      loadThumbnailForDisplay(store as AssetLibraryStore, digest));
  const pool = new ObjectUrlPool({
    create: options.createUrl,
    revoke: options.revokeUrl,
  });
  // digest -> URL currently held in the pool.
  const urls = new Map<string, string>();
  const listeners = new Set<(snapshot: LocalAssetPageSnapshot) => void>();
  let snapshot: LocalAssetPageSnapshot = EMPTY_LOCAL_ASSET_PAGE;
  let cursor: AssetPageCursor = {};
  const cursorStack: AssetPageCursor[] = [];
  // Cursor state of the last page that was committed, restored when a load fails.
  let committedCursor: AssetPageCursor = {};
  let committedStack: AssetPageCursor[] = [];
  let pinnedRef: LocalAssetRef | null = null;
  let pinnedLoadedFor: LocalAssetRef | null = null;
  let generation = 0;
  let disposed = false;

  const publish = (next: LocalAssetPageSnapshot) => {
    snapshot = next;

    for (const listener of [...listeners]) {
      listener(snapshot);
    }
  };

  const withUrl = (entry: LocalAssetEntry): LocalAssetPageEntry => ({
    ...entry,
    thumbnailUrl: urls.get(entry.digest) ?? null,
  });

  const wantsThumbnail = (entry: LocalAssetEntry) =>
    entry.row.status === "present";

  const releaseExcept = (visible: ReadonlySet<string>) => {
    for (const digest of [...urls.keys()]) {
      if (!visible.has(digest)) {
        urls.delete(digest);
        pool.release(digest);
      }
    }
  };

  const readPinned = async (
    ref: LocalAssetRef,
  ): Promise<
    {kind: "missing"} | {kind: "present"; entry: LocalAssetEntry}
  > => {
    const parsed = parseLocalAssetRef(ref);

    if (parsed === null || parsed.category !== category) {
      return {kind: "missing"};
    }

    const row = await store.getAssetRow(ref);

    return row.status === "absent"
      ? {kind: "missing"}
      : {
          kind: "present",
          entry: {ref, category, digest: parsed.digest, row},
        };
  };

  const load = async (): Promise<void> => {
    if (disposed) {
      return;
    }

    generation += 1;

    const mine = generation;
    const isStale = () => disposed || generation !== mine;
    const pinnedForThisLoad = pinnedRef;

    publish({
      ...snapshot,
      loading: true,
      error: null,
      pinnedFor: pinnedForThisLoad,
      pinned:
        pinnedForThisLoad === null
          ? {kind: "none"}
          : pinnedLoadedFor === pinnedForThisLoad
            ? snapshot.pinned
            : {kind: "loading"},
    });

    try {
      let page: Awaited<ReturnType<typeof listLocalAssetPage>>;
      let total: number;
      let pinnedResult:
        | {kind: "none"}
        | Awaited<ReturnType<typeof readPinned>> = {kind: "none"};

      for (;;) {
        [page, total, pinnedResult] = await Promise.all([
          listLocalAssetPage(store as AssetLibraryStore, category, cursor),
          countLocalAssets(store as AssetLibraryStore, category),
          pinnedForThisLoad === null
            ? Promise.resolve({kind: "none"} as const)
            : readPinned(pinnedForThisLoad),
        ]);

        if (isStale()) {
          return;
        }

        // An emptied page (rows deleted elsewhere): step back one page.
        if (page.entries.length === 0 && cursorStack.length > 0) {
          cursor = cursorStack.pop() as AssetPageCursor;
          continue;
        }

        break;
      }

      const pinnedEntry =
        pinnedResult.kind === "present" ? pinnedResult.entry : null;
      const visibleEntries = page.entries;
      const visible = new Set<string>();

      for (const entry of [
        ...visibleEntries,
        ...(pinnedEntry === null ? [] : [pinnedEntry]),
      ]) {
        if (wantsThumbnail(entry)) {
          visible.add(entry.digest);
        }
      }

      releaseExcept(visible);

      const commit = (loading: boolean) => {
        publish({
          entries: visibleEntries.map(withUrl),
          total,
          hasPrevious: cursorStack.length > 0,
          hasNext: page.hasNext,
          loading,
          loaded: true,
          error: null,
          pinnedFor: pinnedForThisLoad,
          pinned:
            pinnedResult.kind === "none"
              ? {kind: "none"}
              : pinnedResult.kind === "missing"
                ? {kind: "missing"}
                : {kind: "present", entry: withUrl(pinnedResult.entry)},
        });
      };

      pinnedLoadedFor = pinnedForThisLoad;
      committedCursor = cursor;
      committedStack = [...cursorStack];
      commit(false);

      const needed = [...visible].filter((digest) => !urls.has(digest));

      if (needed.length === 0) {
        return;
      }

      const results = await Promise.all(
        needed.map(async (digest): Promise<[string, ThumbnailResult]> => {
          try {
            return [digest, await loadThumbnail(digest)];
          } catch {
            return [digest, {ok: false}];
          }
        }),
      );

      if (isStale()) {
        return; // no URL was created for this load
      }

      for (const [digest, result] of results) {
        if (result.ok) {
          urls.set(digest, pool.acquire(digest, result.blob));
        }
      }

      commit(false);
    } catch {
      if (!isStale()) {
        cursor = committedCursor;
        cursorStack.splice(0, cursorStack.length, ...committedStack);
        publish({
          ...snapshot,
          loading: false,
          error: LOCAL_ASSET_LOAD_ERROR,
          pinnedFor: pinnedForThisLoad,
          pinned:
            pinnedForThisLoad === null
              ? {kind: "none"}
              : pinnedLoadedFor === pinnedForThisLoad
                ? snapshot.pinned
                : {kind: "error"},
        });
      }
    }
  };

  return {
    getSnapshot: () => snapshot,

    subscribe(listener: (next: LocalAssetPageSnapshot) => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    /** Sets the pinned ref and (re)loads the current page. */
    sync(ref: LocalAssetRef | null): Promise<void> {
      pinnedRef = ref;

      return load();
    },

    /** Reloads the current page (stepping back if it became empty). */
    refresh: (): Promise<void> => load(),

    next(): Promise<void> {
      const last = snapshot.entries[snapshot.entries.length - 1];

      if (snapshot.loading || !snapshot.hasNext || last === undefined) {
        return Promise.resolve();
      }

      cursorStack.push(cursor);
      cursor = {after: last.ref};

      return load();
    },

    previous(): Promise<void> {
      const previous = snapshot.loading ? undefined : cursorStack.pop();

      if (previous === undefined) {
        return Promise.resolve();
      }

      cursor = previous;

      return load();
    },

    dispose() {
      disposed = true;
      generation += 1;
      listeners.clear();
      releaseExcept(new Set());
    },
  };
};

export type LocalAssetPageController = ReturnType<
  typeof createLocalAssetPageController
>;
