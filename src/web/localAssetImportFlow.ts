import {
  commitPreparedLocalAssetImport,
  LocalAssetImportError,
  prepareLocalAssetImport,
  type ImportPhase,
  type PreparedLocalAssetImport,
  type PrepareLocalAssetImportDeps,
} from "./assetLibrary/importAsset.ts";
import type {AssetLibrary} from "./assetLibrary/library.ts";
import type {AssetDialog} from "./assetLibraryContext.ts";
import {evaluateMatchingFile, mismatchDialogText} from "./localAssetUi.ts";
import {
  parseLocalAssetRef,
  type LocalAssetCategory,
  type LocalAssetRef,
} from "../localAssets/refs.ts";

/** Shown for an error that is not a LocalAssetImportError (the details go to the console). */
export const UNEXPECTED_IMPORT_MESSAGE = "The file could not be imported.";

/** R5: the ASSET-002 phase names mapped to the spec's progress copy. */
export const importPhaseText = (phase: ImportPhase): string => {
  switch (phase) {
    case "reading":
      return "Reading…";
    case "validating":
      return "Checking…";
    case "decoding":
      return "Decoding…";
    case "hashing":
      return "Hashing…";
    case "storing":
      return "Saving…";
  }
};

/** Neutral notice after the user cancelled a commit that was waiting for the library lock. */
export const IMPORT_CANCELLED_MESSAGE = "Import cancelled.";

export const importSuccessText = (
  label: string,
  created: boolean,
  category: LocalAssetCategory = "pose",
): string =>
  created
    ? `Imported "${label}".`
    : `"${label}" was already in My ${category === "audio" ? "audio" : "assets"}; its stored copy was refreshed.`;

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
  | {
      ok: false;
      message: string;
      error: unknown;
      /** The user cancelled while the commit waited for the lock; nothing was written and `message` is a notice, not an error. */
      cancelled?: true;
    };

/**
 * Hands the caller a function that cancels the commit, or `null` once it can no
 * longer be cancelled. The commit is cancellable only while it waits for the
 * exclusive library lock; the UI shows Cancel exactly while this holds a function.
 */
export type CommitCancelable = (cancel: (() => void) | null) => void;

/**
 * The "storing" phase plus the exclusive-lock commit; never throws. `signal`
 * cancels the commit only while it waits for the lock (`onLockAcquired` fires
 * when that is over); a cancel ends as `{ok: false, cancelled: true}`.
 */
export const commitPreparedImport = async (
  prepared: PreparedLocalAssetImport,
  library: AssetLibrary,
  options: {
    onPhase?: (phase: ImportPhase) => void;
    deps?: ImportFlowDeps;
    signal?: AbortSignal;
    onLockAcquired?: () => void;
  } = {},
): Promise<CommitImportResult> => {
  try {
    options.onPhase?.("storing");

    const {ref, created} = await commitPreparedLocalAssetImport(
      prepared,
      library,
      {
        ...options.deps,
        signal: options.signal,
        onLockAcquired: options.onLockAcquired,
      },
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
      message: importSuccessText(
        label,
        created,
        parseLocalAssetRef(ref)?.category ?? "pose",
      ),
    };
  } catch (error) {
    if (error instanceof LocalAssetImportError && error.code === "cancelled") {
      return {
        ok: false,
        message: IMPORT_CANCELLED_MESSAGE,
        error,
        cancelled: true,
      };
    }

    return {ok: false, message: describeImportFailure(error), error};
  }
};

/**
 * commitPreparedImport with a Cancel affordance: `onCancelable` gets the cancel
 * function as the commit starts waiting for the lock and `null` as soon as the
 * lock is granted or the commit ends (exactly once). Without `onCancelable` the
 * commit simply cannot be cancelled.
 */
const commitWithCancel = async (
  prepared: PreparedLocalAssetImport,
  library: AssetLibrary,
  options: {
    onPhase?: (phase: ImportPhase) => void;
    deps?: ImportFlowDeps;
    onCancelable?: CommitCancelable;
  },
): Promise<CommitImportResult> => {
  const {onCancelable, ...rest} = options;

  if (onCancelable === undefined) {
    return commitPreparedImport(prepared, library, rest);
  }

  const controller = new AbortController();
  let offered = true;
  const withdraw = () => {
    if (offered) {
      offered = false;
      onCancelable(null);
    }
  };

  onCancelable(() => controller.abort());

  try {
    return await commitPreparedImport(prepared, library, {
      ...rest,
      signal: controller.signal,
      onLockAcquired: withdraw,
    });
  } finally {
    withdraw();
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
  onCancelable,
  deps,
}: {
  file: File;
  category: LocalAssetCategory;
  library: AssetLibrary;
  setInFlight: (inFlight: boolean) => void;
  /** Applies the imported ref to the selected scene (App's onChange path). */
  apply: (ref: LocalAssetRef) => void;
  onPhase?: (phase: ImportPhase) => void;
  /** Offers Cancel while "Saving…" waits for the library lock (see CommitCancelable). */
  onCancelable?: CommitCancelable;
  deps?: ImportFlowDeps;
}): Promise<CommitImportResult> =>
  withImportLock(setInFlight, async () => {
    const prepared = await prepareImportFile(file, category, {onPhase, deps});

    if (!prepared.ok) {
      return prepared;
    }

    const committed = await commitWithCancel(prepared.prepared, library, {
      onPhase,
      deps,
      onCancelable,
    });

    if (committed.ok) {
      apply(committed.ref);
    }

    return committed;
  });

export const DIALOG_BLOCKED_MESSAGE =
  "Close the open panel and try Import matching file again.";

export type MismatchDialog = Extract<AssetDialog, {kind: "mismatch"}>;

/** How the mismatch dialog ended (reported through `onDialogSettled`). */
export type MatchingFileDialogResult =
  | {kind: "replaced"; message: string}
  | {kind: "cancelled"}
  /** The user cancelled "Use it as replacement" while it waited for the lock; nothing was written. */
  | {kind: "commit-cancelled"; message: string}
  | {kind: "failed"; message: string};

export type MatchingFileOutcome =
  | {kind: "restored"; ref: LocalAssetRef; message: string}
  | {kind: "failed"; message: string; error?: unknown}
  /** The user cancelled the commit while it waited for the lock; nothing was written. */
  | {kind: "cancelled"; message: string}
  /** The mismatch dialog is open and owns the import lock until the user chooses. */
  | {kind: "dialog"};

/**
 * Import matching file (the recovery card): prepare the file, then
 * - same ref (`evaluateMatchingFile` match): commit it, the Story is unchanged;
 * - different image: open the mismatch dialog and keep `setInFlight(true)` until
 *   the user chooses. The dialog host releases the lock after `onReplace` /
 *   `onCancel`, so nothing here clears it again. "Use it as replacement" commits
 *   the prepared bytes and calls `apply` (the selected scene only); Cancel drops
 *   them and writes nothing.
 */
export const runMatchingFileImport = ({
  file,
  category,
  missingRef,
  library,
  setInFlight,
  openMismatchDialog,
  apply,
  onPhase,
  onCancelable,
  onDialogSettled,
  deps,
}: {
  file: File;
  category: LocalAssetCategory;
  missingRef: LocalAssetRef;
  library: AssetLibrary;
  setInFlight: (inFlight: boolean) => void;
  /** Returns false when no dialog could open (another panel is open). */
  openMismatchDialog: (dialog: MismatchDialog) => boolean;
  apply: (ref: LocalAssetRef) => void;
  onPhase?: (phase: ImportPhase) => void;
  /** Offers Cancel while a commit (the exact file, or the replacement) waits for the library lock. */
  onCancelable?: CommitCancelable;
  onDialogSettled?: (result: MatchingFileDialogResult) => void;
  deps?: ImportFlowDeps;
}): Promise<MatchingFileOutcome> =>
  withImportLock<MatchingFileOutcome>(
    setInFlight,
    async () => {
      const prepared = await prepareImportFile(file, category, {onPhase, deps});

      if (!prepared.ok) {
        return {kind: "failed", message: prepared.message, error: prepared.error};
      }

      const evaluation = evaluateMatchingFile(
        missingRef,
        prepared.prepared.ref,
      );

      if (evaluation.kind === "match") {
        const committed = await commitWithCancel(
          prepared.prepared,
          library,
          {onPhase, deps, onCancelable},
        );

        if (committed.ok) {
          return {
            kind: "restored",
            ref: committed.ref,
            message: committed.message,
          };
        }

        return committed.cancelled
          ? {kind: "cancelled", message: committed.message}
          : {kind: "failed", message: committed.message, error: committed.error};
      }

      if (category === "audio") {
        // Replacing an audio ref needs the scene-field pickers of AUDIO-004:
        // refuse the file, write nothing, open no dialog.
        return {
          kind: "failed",
          message: mismatchDialogText(evaluation.candidateRef),
        };
      }

      const opened = openMismatchDialog({
        kind: "mismatch",
        candidateRef: evaluation.candidateRef,
        onReplace: async () => {
          const committed = await commitWithCancel(
            prepared.prepared,
            library,
            {onPhase, deps, onCancelable},
          );

          if (!committed.ok && committed.cancelled) {
            // Resolves on purpose: the dialog host then closes the dialog and
            // releases the import lock, like after Cancel.
            onDialogSettled?.({
              kind: "commit-cancelled",
              message: committed.message,
            });

            return;
          }

          if (!committed.ok) {
            onDialogSettled?.({kind: "failed", message: committed.message});
            throw new Error(committed.message);
          }

          try {
            apply(committed.ref);
          } finally {
            onDialogSettled?.({kind: "replaced", message: committed.message});
          }
        },
        onCancel: () => onDialogSettled?.({kind: "cancelled"}),
      });

      return opened
        ? {kind: "dialog"}
        : {kind: "failed", message: DIALOG_BLOCKED_MESSAGE};
    },
    (outcome) => outcome.kind !== "dialog",
  );
