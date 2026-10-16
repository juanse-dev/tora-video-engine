import {useContext, useEffect, useMemo, useState} from "react";
import type {AssetLibraryStatus} from "../assetLibrary/coordination.ts";
import type {AssetLibraryStore} from "../assetLibrary/store.ts";
import {
  AssetLibraryContext,
  OPENING_ASSET_LIBRARY,
} from "../assetLibraryContext.ts";
import type {LibraryAudioChoices, LibraryAudioOption} from "./audioFields.ts";
import {readLibraryAudioOptions} from "./libraryAudioOptions.ts";

const NO_OPTIONS: readonly LibraryAudioOption[] = Object.freeze([]);

/** What one finished read of the library produced, and the store it came from. */
export type LibraryRead = {
  forStore: AssetLibraryStore;
  rows: readonly LibraryAudioOption[];
};

/**
 * The rows and the `settled` flag for a library status. Not settled: while the
 * library is still opening (`OPENING_ASSET_LIBRARY`), and from the moment a
 * ready library appears until its first read finishes, so the selects say
 * `Loading audio…` instead of `Missing audio …` for a ref nothing has looked
 * up yet. Settled: a library that is unavailable for good (it offers no rows
 * and the selects still show the Story's own value) and a finished read.
 */
export const libraryAudioChoices = (
  status: AssetLibraryStatus,
  read: LibraryRead | null,
): {rows: readonly LibraryAudioOption[]; settled: boolean} => {
  if (status === OPENING_ASSET_LIBRARY) {
    return {rows: NO_OPTIONS, settled: false};
  }

  if (status.kind !== "ready") {
    return {rows: NO_OPTIONS, settled: true};
  }

  return read !== null && read.forStore === status.store
    ? {rows: read.rows, settled: true}
    : {rows: NO_OPTIONS, settled: false};
};

/**
 * One read of the My audio rows, for the effect of `useLibraryAudioOptions`.
 * `settle` runs once, unless the returned cancel function ran first (the
 * effect's cleanup: the library changed or refreshed), in which case the result
 * of this read, or its failure, is discarded and can never overwrite a newer
 * read's. A failed live read settles with no rows. Without a library nothing is
 * read and nothing settles (the status decides what the selects show).
 */
export const startLibraryAudioRead = (
  store: Pick<AssetLibraryStore, "listAssets" | "getPayloadMeta"> | null,
  settle: (rows: readonly LibraryAudioOption[]) => void,
): (() => void) => {
  if (store === null) {
    return () => {};
  }

  const controller = new AbortController();
  const deliver = (rows: readonly LibraryAudioOption[]) => {
    if (!controller.signal.aborted) {
      settle(rows);
    }
  };

  readLibraryAudioOptions(store, controller.signal).then(deliver, () =>
    deliver(NO_OPTIONS),
  );

  return () => controller.abort();
};

/**
 * The My audio rows for the sound selects. Re-read whenever the library
 * changes (an import, rename or delete in this or another tab); the previous
 * rows stay in place while it re-reads. The returned object is stable while
 * neither the rows nor `settled` change, so memoized selects keep their options.
 */
export const useLibraryAudioOptions = (): LibraryAudioChoices => {
  const context = useContext(AssetLibraryContext);
  const status = context?.status ?? OPENING_ASSET_LIBRARY;
  const store = status.kind === "ready" ? status.store : null;
  const refreshToken = context?.refreshToken ?? 0;
  const [read, setRead] = useState<LibraryRead | null>(null);

  useEffect(() => {
    if (store === null) {
      return;
    }

    return startLibraryAudioRead(store, (rows) =>
      setRead({forStore: store, rows}),
    );
  }, [store, refreshToken]);

  const {rows, settled} = libraryAudioChoices(status, read);

  return useMemo(() => ({rows, settled}), [rows, settled]);
};
