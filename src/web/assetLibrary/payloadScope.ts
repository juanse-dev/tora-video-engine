import {
  buildLocalAssetRef,
  type LocalAssetCategory,
  type LocalAssetRef,
} from "../../localAssets/refs.ts";

export type DerivedStoreName = "thumbnails" | "waveforms";

/**
 * What deleting one row may take with it. `protectingRefs` are the rows of the
 * same digest in OTHER categories whose presence keeps the shared payload (even
 * a corrupt row protects it): the two image categories protect each other,
 * audio has no other category. `derivedStores` are the per-digest stores that
 * hold derivatives of this kind of payload (an image has no waveform, audio has
 * no thumbnail).
 */
export const deletionScope = (
  category: LocalAssetCategory,
  digest: string,
): {
  protectingRefs: LocalAssetRef[];
  derivedStores: readonly DerivedStoreName[];
} =>
  // Audio has no protecting refs: no byte string is both an accepted image and
  // an accepted audio file (different magic bytes), so an audio digest is never
  // shared with an image. If that ever changed, a shared digest would need
  // protection here.
  category === "audio"
    ? {protectingRefs: [], derivedStores: ["waveforms"]}
    : {
        protectingRefs: [
          buildLocalAssetRef(
            category === "pose" ? "background" : "pose",
            digest,
          ),
        ],
        derivedStores: ["thumbnails"],
      };
