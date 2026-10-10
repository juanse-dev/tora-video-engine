import {shortAssetId} from "../../localAssets/sources.ts";
import type {LocalAssetPageEntry} from "../localAssetPageController.ts";

type LocalAssetCardProps = {
  entry: LocalAssetPageEntry;
  selected: boolean;
  /** The scene's current ref, pinned as the first card. */
  current?: boolean;
  /** Management buttons are shown only while the library can be changed. */
  canManage: boolean;
  onSelect: () => void;
};

/**
 * One My assets card. The wrapper is not interactive; the selection button and
 * the actions row are siblings so no interactive element is ever nested.
 *
 * Rename and Delete are rendered disabled until the flows in ASSET-003 task 3.
 */
export const LocalAssetCard = ({
  entry,
  selected,
  current = false,
  canManage,
  onSelect,
}: LocalAssetCardProps) => {
  const className = [
    "asset-card",
    "local-asset-card",
    selected ? "selected" : "",
    current ? "current" : "",
  ]
    .filter(Boolean)
    .join(" ");
  // Each button names its asset, so a screen reader can tell the cards apart.
  const actions = (buttons: Array<{text: string; label: string}>) =>
    canManage ? (
      <div className="local-asset-actions">
        {buttons.map(({text, label: accessibleName}) => (
          <button
            key={text}
            type="button"
            aria-label={accessibleName}
            disabled
          >
            {text}
          </button>
        ))}
      </div>
    ) : null;

  if (entry.row.status !== "present") {
    // A damaged row can only be deleted, never applied.
    return (
      <div className={className} data-local-asset-card={entry.ref}>
        <div className="local-asset-body">
          <span className="local-asset-thumbnail-fallback" aria-hidden="true" />
          <span className="asset-card-copy">
            <strong>Damaged entry</strong>
            <small>{shortAssetId(entry.ref)}</small>
            <span className="local-badge">Local</span>
          </span>
        </div>
        {actions([
          {
            text: "Delete",
            label: `Delete damaged entry ${shortAssetId(entry.ref)}`,
          },
        ])}
      </div>
    );
  }

  const label = entry.row.value.label;

  return (
    <div className={className} data-local-asset-card={entry.ref}>
      <button
        type="button"
        className="local-asset-select"
        aria-pressed={selected}
        onClick={onSelect}
      >
        {entry.thumbnailUrl === null ? (
          <span className="local-asset-thumbnail-fallback" aria-hidden="true">
            {label}
          </span>
        ) : (
          // Editor chrome thumbnail, not Remotion composition media.
          // eslint-disable-next-line @remotion/warn-native-media-tag
          <img
            src={entry.thumbnailUrl}
            alt=""
            className={`asset-thumbnail ${
              entry.category === "pose"
                ? "pose-thumbnail"
                : "background-thumbnail"
            }`}
          />
        )}
        <span className="asset-card-copy">
          <strong>{label}</strong>
          <span className="local-badge">Local</span>
          {current ? <span className="local-badge">Current</span> : null}
          <span className="asset-selection-mark" aria-hidden="true">
            {selected ? "✓ Selected" : "Select"}
          </span>
        </span>
      </button>
      {actions([
        {text: "Rename", label: `Rename ${label}`},
        {text: "Delete", label: `Delete ${label}`},
      ])}
    </div>
  );
};
