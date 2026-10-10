import {useEffect, useRef, useState} from "react";
import {shortAssetId} from "../../localAssets/sources.ts";
import type {LocalAssetPageEntry} from "../localAssetPageController.ts";

type LocalAssetCardProps = {
  entry: LocalAssetPageEntry;
  selected: boolean;
  /** The scene's current ref, pinned as the first card. */
  current?: boolean;
  /** Management buttons are shown only while the library can be changed. */
  canManage: boolean;
  /** An App transition panel is open, so a dialog cannot open now. */
  deleteDisabled?: boolean;
  onSelect: () => void;
  /** Resolves to an inline error message, or null once the rename is done. */
  onRename: (label: string) => Promise<string | null>;
  onDelete: () => void;
};

/**
 * One My assets card. The wrapper is not interactive; the selection button and
 * the actions row are siblings so no interactive element is ever nested.
 * Renaming swaps the selection button and the actions row for an input with
 * Save / Cancel.
 */
export const LocalAssetCard = ({
  entry,
  selected,
  current = false,
  canManage,
  deleteDisabled = false,
  onSelect,
  onRename,
  onDelete,
}: LocalAssetCardProps) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  // Identifies the current edit session; a save that finishes after its
  // session ended (or after a newer one began) must not touch the editor.
  const editSessionRef = useRef(0);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      renameButtonRef.current?.focus();
    }
  }, [editing]);

  const className = [
    "asset-card",
    "local-asset-card",
    selected ? "selected" : "",
    current ? "current" : "",
  ]
    .filter(Boolean)
    .join(" ");

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
        {canManage ? (
          <div className="local-asset-actions">
            <button
              type="button"
              aria-label={`Delete damaged entry ${shortAssetId(entry.ref)}`}
              disabled={deleteDisabled}
              onClick={onDelete}
            >
              Delete
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const label = entry.row.value.label;

  const stopEditing = () => {
    editSessionRef.current += 1;
    restoreFocusRef.current = true;
    setEditing(false);
    setError(null);
  };
  const save = async () => {
    if (saving) {
      return;
    }

    const session = editSessionRef.current;

    setSaving(true);

    const message = await onRename(draft);

    setSaving(false);

    if (session !== editSessionRef.current) {
      return; // the edit this save belonged to is over
    }

    if (message === null) {
      stopEditing();
    } else {
      setError(message);
    }
  };

  if (editing) {
    return (
      <div className={className} data-local-asset-card={entry.ref}>
        <div className="local-asset-rename">
          <input
            ref={inputRef}
            type="text"
            className="local-asset-rename-input"
            aria-label={`New name for ${label}`}
            aria-invalid={error !== null}
            value={draft}
            disabled={saving}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || saving) {
                return;
              }

              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              } else if (event.key === "Escape") {
                event.preventDefault();
                stopEditing();
              }
            }}
          />
          {error === null ? null : (
            <small className="local-asset-rename-error" role="alert">
              {error}
            </small>
          )}
          <div className="local-asset-actions">
            <button type="button" onClick={() => void save()} disabled={saving}>
              Save
            </button>
            <button type="button" onClick={stopEditing} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

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
      {canManage ? (
        // Each button names its asset, so a screen reader can tell the cards apart.
        <div className="local-asset-actions">
          <button
            ref={renameButtonRef}
            type="button"
            aria-label={`Rename ${label}`}
            onClick={() => {
              editSessionRef.current += 1;
              setDraft(label);
              setError(null);
              setEditing(true);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            aria-label={`Delete ${label}`}
            disabled={deleteDisabled}
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
};
