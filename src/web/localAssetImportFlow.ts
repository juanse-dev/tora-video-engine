import {
  commitPreparedLocalAssetImport,
  LocalAssetImportError,
  prepareLocalAssetImport,
  type ImportPhase,
  type PreparedLocalAssetImport,
  type PrepareLocalAssetImportDeps,
} from "./assetLibrary/importAsset.ts";
import type {AssetLibrary} from "./assetLibrary/library.ts";
import type {LocalAssetCategory, LocalAssetRef} from "../localAssets/refs.ts";

/** Shown for an error that is not a LocalAssetImportError (the details go to the console). */
export const UNEXPECTED_IMPORT_MESSAGE = "The file could not be imported.";

/** R5: the ASSET-002 phase names mapped to the spec's progress copy. */
export const importPhaseText = (phase: ImportPhase): string => {
  switch (phase) {
    case "reading":
      return "Reading…";
    case "validating":
      return "Checking…";
    case "hashing":
      return "Hashing…";
    case "storing":
      return "Saving…";
  }
};

export const importSuccessText = (label: string, created: boolean): string =>
  created
    ? `Imported "${label}".`
    : `"${label}" was already in My assets; its stored copy was refreshed.`;

export type ImportFlowDeps = PrepareLocalAssetImportDeps & {
  storage?: StorageManager;
};

/** A user-facing message for a failed import; unexpected errors get a generic one. */
export const describeImportFailure = (error: unknown): string =>
  error instanceof LocalAssetImportError
    ? error.message
    : UNEXPECTED_IMPORT_MESSAGE;

/**
 * Runs `body` with the authoring lock held: `setInFlight(true)` before it
 * starts, `setInFlight(false)` when it ends or throws. `release` can return
 * false for a result that keeps the lock (the mismatch dialog owns it from
 * there and clears it on Use it as replacement / Cancel). A throw always
 * releases.
 */
export const withImportLock = async <T>(
  setInFlight: (inFlight: boolean) => void,
  body: () => Promise<T>,
  release: (result: T) => boolean = () => true,
): Promise<T> => {
  let keepLock = false;

  setInFlight(true);

  try {
    const result = await body();

    keepLock = !release(result);

    return result;
  } finally {
    if (!keepLock) {
      setInFlight(false);
    }
  }
};

export type PrepareFileResult =
  | {ok: true; prepared: PreparedLocalAssetImport}
  | {ok: false; message: string; error: unknown};

/**
 * Reads, checks, hashes and decodes `file` (nothing is written). Never throws:
 * a failure becomes `{ok: false}` with a user-facing message. Task 4's Import
 * matching file builds on this and `commitPreparedImport`.
 */
export const prepareImportFile = async (
  file: File,
  category: LocalAssetCategory,
  options: {onPhase?: (phase: ImportPhase) => void; deps?: ImportFlowDeps} = {},
): Promise<PrepareFileResult> => {
  try {
    const prepared = await prepareLocalAssetImport(file, category, {
      ...options.deps,
      onPhase: options.onPhase,
    });

    return {ok: true, prepared};
  } catch (error) {
    return {ok: false, message: describeImportFailure(error), error};
  }
};

export type CommitImportResult =
  | {
      ok: true;
      ref: LocalAssetRef;
      created: boolean;
      /** The stored label (an existing row keeps its own, possibly renamed, label). */
      label: string;
      message: string;
    }
  | {ok: false; message: string; error: unknown};

/** The "storing" phase plus the exclusive-lock commit; never throws. */
export const commitPreparedImport = async (
  prepared: PreparedLocalAssetImport,
  library: AssetLibrary,
  options: {onPhase?: (phase: ImportPhase) => void; deps?: ImportFlowDeps} = {},
): Promise<CommitImportResult> => {
  try {
    options.onPhase?.("storing");

    const {ref, created} = await commitPreparedLocalAssetImport(
      prepared,
      library,
      options.deps,
    );
    let label = prepared.defaultLabel;

    if (!created) {
      // The row already existed and kept its own label; say that one.
      try {
        const row = await library.store.getAssetRow(ref);

        if (row.status === "present") {
          label = row.value.label;
        }
      } catch {
        // The import succeeded; the default label is a fine fallback.
      }
    }

    return {
      ok: true,
      ref,
      created,
      label,
      message: importSuccessText(label, created),
    };
  } catch (error) {
    return {ok: false, message: describeImportFailure(error), error};
  }
};

/**
 * Import pose / Import background: lock, prepare, commit, then apply the ref
 * (still under the lock, so the scene cannot have moved) and unlock.
 */
export const runLocalAssetImport = ({
  file,
  category,
  library,
  setInFlight,
  apply,
  onPhase,
  deps,
}: {
  file: File;
  category: LocalAssetCategory;
  library: AssetLibrary;
  setInFlight: (inFlight: boolean) => void;
  /** Applies the imported ref to the selected scene (App's onChange path). */
  apply: (ref: LocalAssetRef) => void;
  onPhase?: (phase: ImportPhase) => void;
  deps?: ImportFlowDeps;
}): Promise<CommitImportResult> =>
  withImportLock(setInFlight, async () => {
    const prepared = await prepareImportFile(file, category, {onPhase, deps});

    if (!prepared.ok) {
      return prepared;
    }

    const committed = await commitPreparedImport(prepared.prepared, library, {
      onPhase,
      deps,
    });

    if (committed.ok) {
      apply(committed.ref);
    }

    return committed;
  });
