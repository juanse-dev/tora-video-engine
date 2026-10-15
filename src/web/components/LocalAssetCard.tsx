import {useEffect, useRef, useState} from "react";
import {formatAudioDuration} from "../../audio/formatDuration.ts";
import {shortAssetId} from "../../localAssets/sources.ts";
import type {MutationCancelable} from "../localAssetManageFlow.ts";
import type {LocalAssetPageEntry} from "../localAssetPageController.ts";
import {WaveformCanvas} from "./WaveformCanvas.tsx";

/** The audio preview controls of a My audio card. */
export type LocalAssetCardPreview = {
  /** The sound is loading or playing: the button says Stop. */
  active: boolean;
  /** Shown under the card when the preview could not start or broke off. */
  error: string | null;
  onToggle: () => void;
};

type LocalAssetCardProps = {
  entry: LocalAssetPageEntry;
  selected: boolean;
  /** The scene's current ref, pinned as the first card. */
  current?: boolean;
  /** Management buttons are shown only while the library can be changed. */
  canManage: boolean;
  /** An App transition panel is open, so a dialog cannot open now. */
  deleteDisabled?: boolean;
  /** Absent: the card is not selectable (My audio cards never are: the Music, Sound effect and Voice selects pick sounds). */
  onSelect?: () => void;
  /**
   * Resolves to an inline error message, or null once the rename is done (or
   * cancelled). It calls `onCancelable` with a function while the rename waits
   * for the library lock, and with null once it can no longer be cancelled.
   */
  onRename: (
    label: string,
    onCancelable: MutationCancelable,
  ) => Promise<string | null>;
  onDelete: () => void;
  /** My audio only: the Play / Stop toggle. */
  preview?: LocalAssetCardPreview;
};

/**
 * One My assets card. The wrapper is not interactive; the selection button and
 * the actions row are siblings so no interactive element is ever nested.
 * Renaming swaps the selection button and the actions row for an input with
 * Save / Cancel. While a save waits for the library lock (another tab holds
 * it) Cancel stays enabled and abandons the rename.
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
  preview,
}: LocalAssetCardProps) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Set only while the save waits for the library lock: Cancel then aborts it.
  const [cancelWait, setCancelWait] = useState<(() => void) | null>(null);
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

    // A function is wrapped: useState would call it as an updater.
    const message = await onRename(draft, (cancel) =>
      setCancelWait(() => cancel),
    );

    setSaving(false);
    setCancelWait(null);

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
          {cancelWait === null ? null : (
            <small>Waiting for another tab to finish using My assets…</small>
          )}
          <div className="local-asset-actions">
            <button type="button" onClick={() => void save()} disabled={saving}>
              Save
            </button>
            <button
              type="button"
              onClick={() => (cancelWait === null ? stopEditing() : cancelWait())}
              disabled={saving && cancelWait === null}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isAudio = entry.category === "audio";
  const body = (
    <>
      {isAudio ? (
        entry.waveform !== undefined && entry.audio !== undefined ? (
          <WaveformCanvas
            className="waveform-thumbnail"
            waveform={entry.waveform}
            seconds={entry.audio.durationSeconds}
          />
        ) : (
          <span className="local-asset-thumbnail-fallback" aria-hidden="true">
            ♪
          </span>
        )
      ) : entry.thumbnailUrl === null ? (
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
        {isAudio ? (
          <small data-audio-duration="">
            {entry.audio === undefined
              ? "–:––"
              : formatAudioDuration(entry.audio.durationSeconds)}
          </small>
        ) : null}
        {current ? <span className="local-badge">Current</span> : null}
        {onSelect === undefined ? null : (
          <span className="asset-selection-mark" aria-hidden="true">
            {selected ? "✓ Selected" : "Select"}
          </span>
        )}
      </span>
    </>
  );

  return (
    <div className={className} data-local-asset-card={entry.ref}>
      {onSelect === undefined ? (
        <div className="local-asset-select local-asset-static">{body}</div>
      ) : (
        <button
          type="button"
          className="local-asset-select"
          aria-pressed={selected}
          onClick={onSelect}
        >
          {body}
        </button>
      )}
      {canManage ? (
        // Each button names its asset, so a screen reader can tell the cards apart.
        <div className="local-asset-actions">
          {preview === undefined ? null : (
            <button
              type="button"
              aria-label={`${preview.active ? "Stop" : "Play"} ${label}`}
              onClick={preview.onToggle}
            >
              {preview.active ? "Stop" : "Play"}
            </button>
          )}
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
      {preview === undefined ? null : (
        // Always mounted, only its text changes: a live region that appears
        // already holding its message is not reliably announced.
        <small className="audio-preview-error" role="status" data-audio-preview-error="">
          {preview.error ?? ""}
        </small>
      )}
    </div>
  );
};
