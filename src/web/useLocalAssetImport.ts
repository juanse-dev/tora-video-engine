import {useCallback, useContext, useRef, useState} from "react";
import type {
  LocalAssetCategory,
  LocalAssetRef,
} from "../localAssets/refs.ts";
import {LocalAssetImportError, type ImportPhase} from "./assetLibrary/importAsset.ts";
import {AssetLibraryContext} from "./assetLibraryContext.ts";
import {
  importPhaseText,
  runLocalAssetImport,
  runMatchingFileImport,
  UNEXPECTED_IMPORT_MESSAGE,
} from "./localAssetImportFlow.ts";
import {libraryFromContext} from "./localAssetManageFlow.ts";

export type LocalAssetImportUi = {
  /** Current phase ("Reading…"), else the last success message, else "". For a role="status" line. */
  statusText: string;
  /** The last failure message, for a role="alert" line. */
  errorText: string | null;
  importFile: (file: File) => Promise<void>;
  /** Import matching file for `missingRef` (the recovery card). */
  importMatchingFile: (file: File, missingRef: LocalAssetRef) => Promise<void>;
  /** Drops a stale message (called when a rename or delete starts). */
  clearOutcome: () => void;
};

/**
 * Import pose / Import background for one category: holds the authoring lock
 * for the whole import, shows its progress, and applies the imported ref to the
 * selected scene through `onImported` (the catalog's onChange path).
 */
export const useLocalAssetImport = (
  category: LocalAssetCategory,
  onImported: (ref: LocalAssetRef) => void,
): LocalAssetImportUi => {
  const context = useContext(AssetLibraryContext);
  const [phase, setPhase] = useState<ImportPhase | null>(null);
  const [outcome, setOutcome] = useState<
    {kind: "success" | "error"; text: string} | null
  >(null);
  const runningRef = useRef(false);
  // The import can outlive a render; always use the latest of these. The
  // latest `onImported` is safe because it is bound to the scene that was
  // selected when the import started: the import lock (and the mismatch
  // dialog, which holds it) freezes scene selection and structure until the
  // ref is applied.
  const contextRef = useRef(context);
  const onImportedRef = useRef(onImported);

  contextRef.current = context;
  onImportedRef.current = onImported;

  const importFile = useCallback(
    async (file: File) => {
      const current = contextRef.current;
      const library = current === null ? null : libraryFromContext(current);

      if (current === null || library === null || runningRef.current) {
        return;
      }

      runningRef.current = true;
      setOutcome(null);
      setPhase("reading");

      try {
        const result = await runLocalAssetImport({
          file,
          category,
          library,
          setInFlight: current.setAssetImportInFlight,
          onPhase: setPhase,
          apply: (ref) => onImportedRef.current(ref),
        });

        if (result.ok) {
          setOutcome({kind: "success", text: result.message});
        } else {
          if (!(result.error instanceof LocalAssetImportError)) {
            console.error("My assets import failed:", result.error);
          }

          setOutcome({kind: "error", text: result.message});
        }
      } catch (error) {
        console.error("My assets import failed:", error);
        setOutcome({kind: "error", text: UNEXPECTED_IMPORT_MESSAGE});
      } finally {
        runningRef.current = false;
        setPhase(null);
      }
    },
    [category],
  );

  const importMatchingFile = useCallback(
    async (file: File, missingRef: LocalAssetRef) => {
      const current = contextRef.current;
      const library = current === null ? null : libraryFromContext(current);

      if (current === null || library === null || runningRef.current) {
        return;
      }

      runningRef.current = true;
      setOutcome(null);
      setPhase("reading");

      try {
        const result = await runMatchingFileImport({
          file,
          category,
          missingRef,
          library,
          setInFlight: current.setAssetImportInFlight,
          openMismatchDialog: current.openAssetDialog,
          apply: (ref) => onImportedRef.current(ref),
          onPhase: setPhase,
          // The mismatch dialog host owns the lock from here and reports
          // errors itself; this only keeps the status line honest.
          onDialogSettled: (settled) => {
            setPhase(null);
            setOutcome(
              settled.kind === "replaced"
                ? {kind: "success", text: settled.message}
                : null,
            );
          },
        });

        if (result.kind === "restored") {
          setOutcome({kind: "success", text: result.message});
        } else if (result.kind === "failed") {
          if (
            result.error !== undefined &&
            !(result.error instanceof LocalAssetImportError)
          ) {
            console.error("My assets import failed:", result.error);
          }

          setOutcome({kind: "error", text: result.message});
        }
      } catch (error) {
        console.error("My assets import failed:", error);
        setOutcome({kind: "error", text: UNEXPECTED_IMPORT_MESSAGE});
      } finally {
        runningRef.current = false;
        // With the mismatch dialog open, the phase stays clear until its
        // "Saving…" (Use it as replacement) or its end.
        setPhase(null);
      }
    },
    [category],
  );

  const clearOutcome = useCallback(() => setOutcome(null), []);

  return {
    statusText:
      phase !== null
        ? importPhaseText(phase)
        : outcome?.kind === "success"
          ? outcome.text
          : "",
    errorText: outcome?.kind === "error" ? outcome.text : null,
    importFile,
    importMatchingFile,
    clearOutcome,
  };
};
