import {isAudioPayload} from "../../localAssets/readiness.ts";
import {parseLocalAssetRef, type LocalAudioRef} from "../../localAssets/refs.ts";
import type {AssetLibraryStatus} from "../assetLibrary/coordination.ts";
import type {IntegrityCache} from "../assetLibrary/integrity.ts";
import type {LocalAssetUrlPool} from "../localAssetState.ts";
import type {PreviewUrlLease} from "./previewPlayback.ts";

/**
 * A verified object URL for a library sound, for the My audio preview. The bytes
 * go through the same integrity check as the Player's (`IntegrityCache.verify`,
 * INV-12) and the URL comes from the page's one pool (the same pool as images),
 * leased for as long as the preview holds it. Rejects when the library is not
 * ready, the stored copy is missing or damaged, or it is not audio.
 */
export const acquireAudioPreviewUrl = async (input: {
  library: AssetLibraryStatus | null;
  cache: Pick<IntegrityCache, "verify">;
  pool: LocalAssetUrlPool;
  ref: LocalAudioRef;
  signal: AbortSignal;
}): Promise<PreviewUrlLease> => {
  const {library, cache, pool, ref, signal} = input;
  const parsed = parseLocalAssetRef(ref);

  if (library?.kind !== "ready" || parsed === null) {
    throw new Error("My audio is not available.");
  }

  const verification = await cache.verify(library.store, parsed.digest, {signal});

  signal.throwIfAborted();

  if (!verification.ok || !isAudioPayload(verification.payload)) {
    throw new Error("The stored audio is missing or damaged.");
  }

  const url = pool.acquire(parsed.digest, verification.blob);
  let released = false;

  return {
    url,
    release: () => {
      if (!released) {
        released = true;
        pool.release(parsed.digest);
      }
    },
  };
};
