import {useEffect, useId, useRef, useState} from "react";
import type {AssetDialog} from "../assetLibraryContext.ts";
import {
  deleteConfirmationText,
  deleteConfirmButtonLabel,
  mismatchDialogText,
  runAssetDialogCallback,
} from "../localAssetUi.ts";

// The dialogs share the App transition panels' styles. The class lives in one
// constant because both dialog kinds use this single shell, and a literal
// className here would add a false positive from the
// @remotion/non-pure-animation lint rule, which reacts to "transition".
const ASSET_DIALOG_CLASS_NAME = "transition-panel";

type AssetDialogHostProps = {
  dialog: AssetDialog | null;
  /** MP4 render phases only; the dialog itself also sets the broader authoring lock. */
  renderAuthoringLocked: boolean;
  assetImportInFlight: boolean;
  setAssetImportInFlight: (inFlight: boolean) => void;
  /** Closes `dialog` only if it is still the open one (a newer dialog is left alone). */
  onClose: (dialog: AssetDialog) => void;
};

/**
 * Renders the open asset dialog (delete confirmation / matching-file mismatch).
 * App renders it next to the transition panel, outside the disabled authoring
 * fieldset, so the buttons stay enabled while the Story is frozen.
 *
 * Failure policy (see AssetDialog in assetLibraryContext.ts): a callback that
 * throws or rejects is always logged with console.error, never left unhandled.
 * A failed confirm/replace also shows its message in a role="alert" line and
 * keeps the dialog open; a failed cancel just closes the dialog.
 *
 * Accessibility: the dialog is labelled by its heading text, focus moves to
 * Cancel (the non-destructive choice, first for delete) when it opens and
 * returns to the previously focused element when it closes, and Escape
 * cancels.
 */
export const AssetDialogHost = ({
  dialog,
  renderAuthoringLocked,
  assetImportInFlight,
  setAssetImportInFlight,
  onClose,
}: AssetDialogHostProps) => {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{
    dialog: AssetDialog;
    message: string;
  } | null>(null);
  const headingId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  // The element focused outside the dialog, tracked continuously: opening the
  // dialog disables the authoring fieldset, which can drop focus from the
  // button that opened it before this component sees the open.
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const remember = (event: FocusEvent) => {
      if (
        event.target instanceof HTMLElement &&
        !event.target.closest("[data-asset-dialog]")
      ) {
        openerRef.current = event.target;
      }
    };

    document.addEventListener("focusin", remember);

    return () => document.removeEventListener("focusin", remember);
  }, []);

  useEffect(() => {
    if (dialog === null) {
      return undefined;
    }

    cancelRef.current?.focus();

    return () => {
      if (openerRef.current?.isConnected === true) {
        openerRef.current.focus();
      }
    };
  }, [dialog]);

  if (dialog === null) {
    return null;
  }

  const run = async (
    action: () => void | Promise<void>,
    {closeOnFailure, releaseImport}: {closeOnFailure: boolean; releaseImport: boolean},
  ) => {
    setBusy(true);
    setFailure(null);

    const result = await runAssetDialogCallback(action, () => {
      // The mismatch dialog is part of the import: it always ends here.
      if (releaseImport) {
        setAssetImportInFlight(false);
      }

      setBusy(false);
    });

    if (result.ok) {
      onClose(dialog);

      return;
    }

    console.error("My assets dialog action failed:", result.error);

    if (closeOnFailure) {
      onClose(dialog);
    } else {
      setFailure({dialog, message: result.message});
    }
  };

  const failureMessage =
    failure !== null && failure.dialog === dialog ? failure.message : null;
  const failureLine =
    failureMessage === null ? null : (
      <span role="alert">That didn&apos;t work: {failureMessage}</span>
    );

  const isDelete = dialog.kind === "delete";
  const heading =
    dialog.kind === "delete"
      ? deleteConfirmationText(dialog.label, dialog.category, dialog.sceneCount)
      : mismatchDialogText(dialog.candidateRef);
  const primaryLabel =
    dialog.kind === "delete"
      ? deleteConfirmButtonLabel(dialog.sceneCount)
      : "Use it as replacement for this scene";
  const runPrimary = () =>
    dialog.kind === "delete"
      ? run(dialog.onConfirm, {closeOnFailure: false, releaseImport: false})
      : run(dialog.onReplace, {closeOnFailure: false, releaseImport: true});
  const runCancel = () =>
    dialog.kind === "delete"
      ? onClose(dialog)
      : run(dialog.onCancel, {closeOnFailure: true, releaseImport: true});

  // One shell for both kinds. Delete lists Cancel first, mismatch lists the
  // replacement first (matching the spec's button order).
  const primary = (
    <button
      type="button"
      onClick={() => void runPrimary()}
      disabled={
        busy ||
        (isDelete && (renderAuthoringLocked || assetImportInFlight))
      }
    >
      {primaryLabel}
    </button>
  );
  const cancel = (
    <button
      ref={cancelRef}
      type="button"
      onClick={() => void runCancel()}
      disabled={busy}
    >
      Cancel
    </button>
  );

  return (
    <div
      className={ASSET_DIALOG_CLASS_NAME}
      role="dialog"
      data-asset-dialog=""
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          event.stopPropagation();
          void runCancel();
        }
      }}
    >
      <strong id={headingId}>{heading}</strong>
      {failureLine}
      <div>
        {isDelete ? cancel : primary}
        {isDelete ? primary : cancel}
      </div>
    </div>
  );
};
