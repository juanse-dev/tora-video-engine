import {isAudioPayload} from "../../localAssets/readiness.ts";
import {parseLocalAssetRef, type LocalAudioRef} from "../../localAssets/refs.ts";
import {listLocalAssetPage} from "../assetLibrary/library.ts";
import type {AssetLibraryStore, AssetPageCursor} from "../assetLibrary/store.ts";
import type {LibraryAudioOption} from "./audioFields.ts";

/**
 * EVERY usable My audio row (a present row, never a damaged one), however many
 * there are: the library is read page by page with its own cursor (pages of
 * `LOCAL_ASSET_PAGE_SIZE`, metadata only, no bytes) until it is exhausted, so no
 * valid sound is ever unselectable and the result does not depend on storage
 * order. Order is the caller's concern (`audioSelectOptions` sorts by label).
 * Rows whose label another row shares also get their duration (one metadata
 * read each, no bytes), so the selects can tell them apart. Aborting `signal`
 * stops the read at the next page.
 */
export const readLibraryAudioOptions = async (
  store: Pick<AssetLibraryStore, "listAssets" | "getPayloadMeta">,
  signal?: AbortSignal,
): Promise<LibraryAudioOption[]> => {
  const options: LibraryAudioOption[] = [];
  let cursor: AssetPageCursor = {};

  for (;;) {
    signal?.throwIfAborted();

    const page = await listLocalAssetPage(store as AssetLibraryStore, "audio", cursor);

    for (const entry of page.entries) {
      if (entry.row.status === "present") {
        options.push({
          ref: entry.ref as LocalAudioRef,
          label: entry.row.value.label,
        });
      }
    }

    const last = page.entries.at(-1);

    if (!page.hasNext || last === undefined) {
      break;
    }

    cursor = {after: last.ref};
  }

  const labelCounts = new Map<string, number>();

  for (const option of options) {
    labelCounts.set(option.label, (labelCounts.get(option.label) ?? 0) + 1);
  }

  for (const option of options) {
    const parsed = parseLocalAssetRef(option.ref);

    if ((labelCounts.get(option.label) ?? 0) > 1 && parsed !== null) {
      signal?.throwIfAborted();

      const meta = await store.getPayloadMeta(parsed.digest);

      if (meta.status === "present" && isAudioPayload(meta.value)) {
        option.durationSeconds = meta.value.durationSeconds;
      }
    }
  }

  return options;
};
