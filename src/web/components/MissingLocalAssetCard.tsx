import type {
  LocalAssetCategory,
  LocalAssetRef,
} from "../../localAssets/refs.ts";
import {shortAssetId} from "../../localAssets/sources.ts";
import {describeMissingLocalAsset} from "../localAssetUi.ts";

export type MissingLocalAssetKind = "missing" | "corrupt" | "unavailable";

type MissingLocalAssetCardProps = {
  /** Not named `ref`: React reserves that prop. */
  assetRef: LocalAssetRef;
  category: LocalAssetCategory;
  kind: MissingLocalAssetKind;
  /** 1-based numbers of the scenes using the ref. */
  sceneNumbers: readonly number[];
  /** Why the ref is unavailable here (library status message or the ref's detail). */
  unavailableMessage?: string;
  /**
   * Import matching file. Omit when nothing can be changed (library disabled
   * or unavailable, or an unavailable ref): the card then shows no actions.
   */
  onImportMatching?: (file: File) => void;
  /** An App transition panel is open: imports cannot start. */
  importDisabled?: boolean;
};

/**
 * The Current card for a selected local ref that is not ready: it explains
 * what is wrong and offers "Import matching file" (the original file restores
 * it; a different image opens the mismatch dialog). Choosing any other card
 * replaces the ref, as everywhere else.
 */
export const MissingLocalAssetCard = ({
  assetRef,
  category,
  kind,
  sceneNumbers,
  unavailableMessage = "",
  onImportMatching,
  importDisabled = false,
}: MissingLocalAssetCardProps) => {
  const className =
    "asset-card local-asset-card selected current local-asset-placeholder";
  const action =
    onImportMatching === undefined ? null : (
      <div className="local-asset-actions">
        <label className="file-button import-asset-button">
          Import matching file
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={importDisabled}
            onChange={(event) => {
              const file = event.target.files?.[0];

              if (file !== undefined) {
                onImportMatching(file);
              }

              // Lets the same file be chosen again.
              event.target.value = "";
            }}
          />
        </label>
      </div>
    );

  if (kind === "unavailable") {
    const title = `Local ${category} unavailable`;

    return (
      <div
        className={className}
        role="group"
        aria-label={`${title} ${shortAssetId(assetRef)}`}
        data-missing-local-asset-card={assetRef}
      >
        <span className="asset-card-copy">
          <strong>{title}</strong>
          <small>{shortAssetId(assetRef)}</small>
          {unavailableMessage === "" ? null : (
            <span>{unavailableMessage}</span>
          )}
        </span>
        {action}
      </div>
    );
  }

  const copy = describeMissingLocalAsset({
    ref: assetRef,
    sceneNumbers,
    damaged: kind === "corrupt",
  });

  return (
    <div
      className={className}
      role="group"
      aria-label={`${copy.title} ${copy.shortId}`}
      data-missing-local-asset-card={assetRef}
    >
      <span className="asset-card-copy">
        <strong>{copy.title}</strong>
        <small>{copy.shortId}</small>
        <span>{copy.usedBy}</span>
        {copy.damagedNote === null ? null : <span>{copy.damagedNote}</span>}
        <span>{copy.hint}</span>
      </span>
      {action}
    </div>
  );
};
