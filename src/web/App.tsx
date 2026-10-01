import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {exampleStory} from "../story/exampleStory.ts";
import {serializeStorySource} from "../story/serializeStory.ts";
import type {Story} from "../story/types.ts";
import {
  applyVisualDraftEvaluation,
  createAuthoringState,
} from "./authoringState.ts";
import {evaluateBrowserStoryPolicy} from "./browserPolicy.ts";
import {Preview} from "./components/Preview.tsx";
import {VisualEditor} from "./components/VisualEditor.tsx";
import {YamlEditor} from "./components/YamlEditor.tsx";
import {
  downloadBlob,
  downloadText,
  getMp4DownloadFilename,
  getYamlDownloadFilename,
} from "./downloads.ts";
import {
  canDownloadBrowserRenderSnapshot,
  checkBrowserRenderCapability,
  getBrowserRenderLockStatus,
  retryBrowserRenderCleanup,
  startBrowserRenderTransaction,
  type BrowserRenderCapability,
  type BrowserRenderCleanupBlocked,
  type BrowserRenderPendingOutcome,
} from "./browserRender.ts";
import {hasLossRisk} from "./lossRisk.ts";
import {
  acquirePersistenceOwnership,
  PERSISTENCE_STORAGE_KEY,
  restorePersistedProject,
  serializePersistedEnvelope,
  storiesSemanticallyEqual,
  type PersistenceOwnership,
  type ProtectedRecovery,
} from "./persistence.ts";
import {getWebPlayerConfig} from "./previewConfig.ts";
import type {VisualDraftEvaluation} from "./visualDraft.ts";
import {
  MAX_BROWSER_YAML_SOURCE_BYTES,
  applyYamlState,
  createYamlStateFromActiveStory,
  createYamlStateFromTransferredCandidate,
  evaluateYamlSource,
  getYamlCandidateStory,
  isYamlDirty,
  tryEditYamlBuffer,
  validateYamlBuffer,
  type YamlEditorState,
} from "./yamlState.ts";

type EditorMode = "visual" | "yaml";

type TransitionState =
  | {kind: "visual-to-yaml"}
  | {kind: "yaml-to-visual"}
  | {kind: "reset"}
  | {
      kind: "import";
      source: string;
      story: Story;
      filename: string;
    }
  | null;

type PersistenceConflict = {
  durableStory: Story | null;
};

type PolicyRejectedImport = {
  source: string;
  story: Story;
  filename: string;
  policyMessage: string;
};

type InitialProject = {
  activeStory: Story;
  durableStory: Story | null;
  recovery: ProtectedRecovery | null;
  storageWarning: string | null;
};

type RenderPhase =
  | "idle"
  | "rendering"
  | "cancelling"
  | "finalizing"
  | "success"
  | "failure"
  | "cleanup-blocked";

type RenderUiState = {
  phase: RenderPhase;
  message: string;
  progress: number | null;
};

const getFallbackStory = (): Story => {
  const policy = evaluateBrowserStoryPolicy(exampleStory);

  if (!policy.eligible) {
    throw new Error(
      `Canonical example Story is not browser-eligible: ${policy.message}`,
    );
  }

  return structuredClone(exampleStory);
};

const loadInitialProject = (): InitialProject => {
  const fallback = getFallbackStory();

  try {
    const raw = window.localStorage.getItem(PERSISTENCE_STORAGE_KEY);
    const restored = restorePersistedProject(raw, fallback);

    return {
      activeStory: restored.activeStory,
      durableStory: restored.durableStory,
      recovery: restored.recovery,
      storageWarning: null,
    };
  } catch (error) {
    return {
      activeStory: fallback,
      durableStory: null,
      recovery: null,
      storageWarning:
        error instanceof Error
          ? `Local storage could not be read: ${error.message}`
          : "Local storage could not be read.",
    };
  }
};

const cleanAuthoringState = (activeStory: Story) =>
  createAuthoringState(activeStory);

const optionalStoriesSemanticallyEqual = (
  left: Story | null,
  right: Story | null,
): boolean => {
  if (left === null || right === null) {
    return left === right;
  }

  return storiesSemanticallyEqual(left, right);
};

const recoveriesSemanticallyEqual = (
  left: ProtectedRecovery | null,
  right: ProtectedRecovery | null,
): boolean => {
  if (left === null || right === null) {
    return left === right;
  }

  if (left.kind !== right.kind) {
    return false;
  }

  if (left.kind === "raw" && right.kind === "raw") {
    return left.reason === right.reason && left.raw === right.raw;
  }

  if (left.kind === "policy-rejected" && right.kind === "policy-rejected") {
    return (
      left.policy.reason === right.policy.reason &&
      storiesSemanticallyEqual(left.story, right.story)
    );
  }

  return false;
};

const hasPersistenceConflict = (
  previousDurable: Story | null,
  currentDurable: Story | null,
  activeStory: Story,
): boolean => {
  if (
    currentDurable !== null &&
    storiesSemanticallyEqual(currentDurable, activeStory)
  ) {
    return false;
  }

  if (!optionalStoriesSemanticallyEqual(previousDurable, currentDurable)) {
    return true;
  }

  return (
    currentDurable !== null &&
    !storiesSemanticallyEqual(currentDurable, activeStory)
  );
};

export const App = () => {
  const [initialProject] = useState(loadInitialProject);
  const [authoringState, setAuthoringState] = useState(() =>
    cleanAuthoringState(initialProject.activeStory),
  );
  const [mode, setMode] = useState<EditorMode>("visual");
  const [yamlState, setYamlState] = useState<YamlEditorState | null>(null);
  const [transition, setTransition] = useState<TransitionState>(null);
  const [visualRevision, setVisualRevision] = useState(0);
  const [durableStory, setDurableStory] = useState<Story | null>(
    initialProject.durableStory,
  );
  const [recovery, setRecovery] = useState<ProtectedRecovery | null>(
    initialProject.recovery,
  );
  const [storageWarning, setStorageWarning] = useState<string | null>(
    initialProject.storageWarning,
  );
  const [ownership, setOwnership] = useState<
    PersistenceOwnership | {mode: "checking"}
  >({mode: "checking"});
  const [conflict, setConflict] = useState<PersistenceConflict | null>(null);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [policyRejectedImport, setPolicyRejectedImport] =
    useState<PolicyRejectedImport | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [renderCapability, setRenderCapability] =
    useState<BrowserRenderCapability | null>(null);
  const [renderLockStatus, setRenderLockStatus] = useState<
    "checking" | "available" | "busy" | "unavailable"
  >("checking");
  const [renderUi, setRenderUi] = useState<RenderUiState>({
    phase: "idle",
    message: "Checking browser render support…",
    progress: null,
  });
  const [cleanupRetrying, setCleanupRetrying] = useState(false);

  const {activeStory, visual} = authoringState;
  const previewConfig = getWebPlayerConfig(activeStory);

  const activeStoryChangedFromInitial =
    !storiesSemanticallyEqual(initialProject.activeStory, activeStory);

  const initialRecoveryFallbackStillProtected =
    !activeStoryChangedFromInitial &&
    initialProject.recovery !== null &&
    recoveriesSemanticallyEqual(initialProject.recovery, recovery);

  const activeStoryDurable =
    (ownership.mode === "owner" &&
      persistenceReady &&
      recovery === null &&
      conflict === null &&
      storiesSemanticallyEqual(durableStory, activeStory)) ||
    initialRecoveryFallbackStillProtected ||
    (!activeStoryChangedFromInitial &&
      recovery === null &&
      ownership.mode === "session-only");

  const lossRisk =
    hasLossRisk({
      visual,
      yaml: yamlState,
      recovery,
      activeStoryDurable,
    }) || policyRejectedImport !== null;

  const renderBlocked =
    visual.pending ||
    (yamlState !== null &&
      (isYamlDirty(yamlState) ||
        yamlState.transferSnapshot !== null));
  const renderInputBlocked =
    renderBlocked ||
    policyRejectedImport !== null ||
    transition !== null;
  const authoringLocked =
    renderUi.phase === "rendering" ||
    renderUi.phase === "cancelling" ||
    renderUi.phase === "finalizing";
  const renderNeedsUnloadWarning =
    authoringLocked || renderUi.phase === "cleanup-blocked";

  const importRequestRef = useRef(0);
  const retryOwnershipInFlightRef = useRef(false);
  const renderInFlightRef = useRef(false);
  const cleanupRetryInFlightRef = useRef(false);
  const renderAbortRef = useRef<AbortController | null>(null);
  const renderCleanupBlockedRef =
    useRef<BrowserRenderCleanupBlocked | null>(null);
  const renderSnapshotRef = useRef<Story | null>(null);
  const liveImportStateRef = useRef({
    mode,
    lossRisk,
    recovery,
  });
  const livePersistenceStateRef = useRef({
    activeStory,
    durableStory,
  });
  const liveRenderStateRef = useRef({
    activeStory,
    renderInputBlocked,
  });

  liveImportStateRef.current = {
    mode,
    lossRisk,
    recovery,
  };
  livePersistenceStateRef.current = {
    activeStory,
    durableStory,
  };
  liveRenderStateRef.current = {
    activeStory,
    renderInputBlocked,
  };

  useEffect(() => {
    let cancelled = false;

    void checkBrowserRenderCapability().then((capability) => {
      if (cancelled) {
        return;
      }

      setRenderCapability(capability);
      setRenderUi((current) => {
        if (current.phase !== "idle") {
          return current;
        }

        return {
          phase: "idle",
          message:
            capability.kind === "ready"
              ? "Browser MP4 rendering is ready."
              : capability.message,
          progress: null,
        };
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const refreshRenderLockStatus = useCallback(async () => {
    const status = await getBrowserRenderLockStatus();
    setRenderLockStatus(status);
  }, []);

  useEffect(() => {
    if (
      renderCapability?.kind !== "ready" ||
      renderUi.phase === "rendering" ||
      renderUi.phase === "cancelling" ||
      renderUi.phase === "finalizing" ||
      renderUi.phase === "cleanup-blocked"
    ) {
      return;
    }

    let cancelled = false;

    const refresh = async () => {
      const status = await getBrowserRenderLockStatus();

      if (!cancelled) {
        setRenderLockStatus(status);
      }
    };

    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 1_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [renderCapability, renderUi.phase]);

  const onVisualEvaluationChange = useCallback(
    (evaluation: VisualDraftEvaluation) => {
      setAuthoringState((current) =>
        applyVisualDraftEvaluation(current, evaluation),
      );
    },
    [],
  );

  const persistStory = useCallback(
    (story: Story) => {
      if (
        ownership.mode !== "owner" ||
        !persistenceReady ||
        recovery !== null ||
        conflict !== null
      ) {
        return false;
      }

      try {
        const serialized = serializePersistedEnvelope(story);
        window.localStorage.setItem(PERSISTENCE_STORAGE_KEY, serialized);
        setDurableStory(story);
        setStorageWarning(null);
        return true;
      } catch (error) {
        setStorageWarning(
          error instanceof Error
            ? `Autosave failed: ${error.message}. Export YAML as backup.`
            : "Autosave failed. Export YAML as backup.",
        );
        return false;
      }
    },
    [conflict, ownership.mode, persistenceReady, recovery],
  );

  useEffect(() => {
    if (
      ownership.mode === "owner" &&
      persistenceReady &&
      recovery === null &&
      conflict === null
    ) {
      if (!storiesSemanticallyEqual(durableStory, activeStory)) {
        persistStory(activeStory);
      } else {
        setStorageWarning((current) =>
          current?.startsWith("Autosave failed:") ? null : current,
        );
      }
    }
  }, [
    activeStory,
    conflict,
    durableStory,
    ownership.mode,
    persistenceReady,
    persistStory,
    recovery,
  ]);

  useEffect(() => {
    if (!lossRisk && !renderNeedsUnloadWarning) {
      return;
    }

    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handler);

    return () => {
      window.removeEventListener("beforeunload", handler);
    };
  }, [lossRisk, renderNeedsUnloadWarning]);

  const adoptOwnership = useCallback(
    async (lease: PersistenceOwnership) => {
      if (lease.mode !== "owner") {
        setPersistenceReady(false);
        setOwnership(lease);

        if (lease.mode === "secondary") {
          setStorageWarning(
            "Another tab owns persistence. Changes in this tab are session-only until ownership is retried.",
          );
        } else {
          setStorageWarning(
            "Web Locks are unavailable. Persistence is session-only; export YAML for recovery.",
          );
        }

        return;
      }

      try {
        const raw = window.localStorage.getItem(PERSISTENCE_STORAGE_KEY);
        const current = restorePersistedProject(raw, getFallbackStory());

        setPersistenceReady(true);
        setOwnership(lease);
        setRecovery(current.recovery);
        setConflict(null);

        if (current.recovery !== null) {
          setRecovery(current.recovery);
          setDurableStory(null);
          setStorageWarning(
            "Stored recovery is protected. Autosave is suspended until it is explicitly discarded.",
          );
          return;
        }

        const liveState = livePersistenceStateRef.current;

        if (
          hasPersistenceConflict(
            liveState.durableStory,
            current.durableStory,
            liveState.activeStory,
          )
        ) {
          setDurableStory(current.durableStory);
          setConflict({durableStory: current.durableStory});
          setStorageWarning(
            current.durableStory === null
              ? "Durable storage was cleared while this tab did not own persistence."
              : "Durable storage changed while this tab did not own persistence.",
          );
          return;
        }

        setDurableStory(current.durableStory);
        setStorageWarning(null);
      } catch (error) {
        lease.release();
        setPersistenceReady(false);
        setOwnership({mode: "session-only"});
        setStorageWarning(
          error instanceof Error
            ? `Persistence ownership was released because storage could not be reread: ${error.message}. Changes are session-only; export YAML for recovery.`
            : "Persistence ownership was released because storage could not be reread. Changes are session-only; export YAML for recovery.",
        );
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    let lease: PersistenceOwnership | null = null;

    void acquirePersistenceOwnership(navigator.locks).then(async (next) => {
      lease = next;

      if (cancelled) {
        if (next.mode === "owner") {
          next.release();
        }
        return;
      }

      if (next.mode !== "owner") {
        setPersistenceReady(false);
        setOwnership(next);
        setStorageWarning(
          next.mode === "secondary"
            ? "Another tab owns persistence. Changes in this tab are session-only until ownership is retried."
            : "Web Locks are unavailable. Persistence is session-only; export YAML for recovery.",
        );
        return;
      }

      try {
        const raw = window.localStorage.getItem(PERSISTENCE_STORAGE_KEY);
        const current = restorePersistedProject(
          raw,
          getFallbackStory(),
        );

        setPersistenceReady(true);
        setOwnership(next);
        setRecovery(current.recovery);
        setConflict(null);

        if (current.recovery !== null) {
          setRecovery(current.recovery);
          setDurableStory(null);
          setStorageWarning(
            "Stored recovery is protected. Autosave is suspended until it is explicitly discarded.",
          );
          return;
        }

        if (
          hasPersistenceConflict(
            initialProject.durableStory,
            current.durableStory,
            initialProject.activeStory,
          )
        ) {
          setDurableStory(current.durableStory);
          setConflict({durableStory: current.durableStory});
          setStorageWarning(
            current.durableStory === null
              ? "Durable storage was cleared before persistence ownership was acquired."
              : "Durable storage changed before persistence ownership was acquired.",
          );
          return;
        }

        setDurableStory(current.durableStory);
        setStorageWarning(null);
      } catch (error) {
        next.release();
        lease = {mode: "session-only"};
        setPersistenceReady(false);
        setOwnership({mode: "session-only"});
        setStorageWarning(
          error instanceof Error
            ? `Persistence ownership was released because storage could not be reread: ${error.message}. Changes are session-only; export YAML for recovery.`
            : "Persistence ownership was released because storage could not be reread. Changes are session-only; export YAML for recovery.",
        );
      }
    });

    return () => {
      cancelled = true;

      if (lease?.mode === "owner") {
        lease.release();
      }
    };
  }, [initialProject.activeStory]);

  useEffect(() => {
    if (ownership.mode !== "checking") {
      retryOwnershipInFlightRef.current = false;
    }
  }, [ownership.mode]);

  const retryPersistenceOwnership = async () => {
    if (
      ownership.mode === "owner" ||
      ownership.mode === "checking" ||
      retryOwnershipInFlightRef.current
    ) {
      return;
    }

    retryOwnershipInFlightRef.current = true;
    setPersistenceReady(false);
    setOwnership({mode: "checking"});

    const lease = await acquirePersistenceOwnership(navigator.locks);
    await adoptOwnership(lease);
  };

  const completeRenderOutcome = (
    outcome: BrowserRenderPendingOutcome,
    snapshot: Story,
  ) => {
    if (outcome.kind === "cancelled") {
      setRenderUi({
        phase: "idle",
        message: "Browser render cancelled.",
        progress: null,
      });
      return;
    }

    if (outcome.kind === "failure") {
      setRenderUi({
        phase: "failure",
        message: `Browser render failed: ${outcome.error.message}`,
        progress: null,
      });
      return;
    }

    if (outcome.consumed) {
      setRenderUi({
        phase: "success",
        message: "MP4 rendered and downloaded successfully.",
        progress: 1,
      });
      return;
    }

    const live = liveRenderStateRef.current;

    if (
      !canDownloadBrowserRenderSnapshot(
        snapshot,
        live.activeStory,
        live.renderInputBlocked,
      )
    ) {
      setRenderUi({
        phase: "failure",
        message:
          "Render completed, but authoring state diverged from the frozen Story snapshot. The MP4 was not downloaded.",
        progress: null,
      });
      return;
    }

    downloadBlob(
      outcome.blob,
      getMp4DownloadFilename(snapshot.title),
    );
    setRenderUi({
      phase: "success",
      message: "MP4 rendered and downloaded successfully.",
      progress: 1,
    });
  };

  const startBrowserRender = async () => {
    if (
      renderInFlightRef.current ||
      renderCapability?.kind !== "ready" ||
      renderLockStatus !== "available" ||
      renderInputBlocked ||
      renderUi.phase === "cleanup-blocked"
    ) {
      return;
    }

    const policy = evaluateBrowserStoryPolicy(activeStory);

    if (!policy.eligible) {
      setRenderUi({
        phase: "failure",
        message: `Active Story failed the browser render policy recheck: ${policy.message}`,
        progress: null,
      });
      return;
    }

    renderInFlightRef.current = true;
    importRequestRef.current += 1;

    const snapshot = structuredClone(activeStory);
    const controller = new AbortController();
    renderAbortRef.current = controller;
    renderSnapshotRef.current = snapshot;
    setRenderUi({
      phase: "rendering",
      message: "Preparing browser render and cleaning temporary storage…",
      progress: 0,
    });

    const outcome = await startBrowserRenderTransaction(snapshot, {
      signal: controller.signal,
      licenseKey: import.meta.env.VITE_REMOTION_LICENSE_KEY || null,
      onProgress: ({progress}) => {
        setRenderUi((current) => {
          if (
            current.phase !== "rendering" &&
            current.phase !== "cancelling"
          ) {
            return current;
          }

          return {
            ...current,
            message:
              current.phase === "cancelling"
                ? "Cancelling render and waiting for cleanup…"
                : `Rendering MP4… ${Math.round(progress * 100)}%`,
            progress,
          };
        });
      },
      consumeBlob: (blob) => {
        const live = liveRenderStateRef.current;

        if (
          !canDownloadBrowserRenderSnapshot(
            snapshot,
            live.activeStory,
            live.renderInputBlocked,
          )
        ) {
          throw new Error(
            "Render completed, but authoring state diverged from the frozen Story snapshot. The MP4 was not downloaded.",
          );
        }

        renderAbortRef.current = null;
        setRenderUi({
          phase: "finalizing",
          message:
            "MP4 rendered. Starting download and cleaning temporary storage…",
          progress: 1,
        });
        downloadBlob(
          blob,
          getMp4DownloadFilename(snapshot.title),
        );
      },
    });

    renderAbortRef.current = null;
    renderInFlightRef.current = false;

    if (outcome.kind === "cleanup-blocked") {
      renderCleanupBlockedRef.current = outcome;
      setRenderUi({
        phase: "cleanup-blocked",
        message:
          outcome.stage === "pre"
            ? "Browser render storage is still being released. Render did not start; retry cleanup before rendering again."
            : outcome.pending?.kind === "success" &&
                outcome.pending.consumed
              ? "MP4 download started, but browser render storage is still being released. Retry cleanup to finish safely."
              : "Render settled, but browser render storage is still being released. Retry cleanup to finish safely.",
        progress: null,
      });
      return;
    }

    renderCleanupBlockedRef.current = null;

    if (outcome.kind === "busy") {
      setRenderLockStatus("busy");
      setRenderUi({
        phase: "idle",
        message:
          "Another Tora tab is rendering. Retry when that render finishes.",
        progress: null,
      });
      return;
    }

    if (outcome.kind === "unsupported") {
      setRenderCapability({
        kind: "unsupported",
        message: outcome.message,
      });
      setRenderUi({
        phase: "failure",
        message: outcome.message,
        progress: null,
      });
      return;
    }

    completeRenderOutcome(outcome, snapshot);
  };

  const cancelBrowserRender = () => {
    if (
      renderUi.phase !== "rendering" ||
      renderAbortRef.current === null
    ) {
      return;
    }

    setRenderUi((current) => ({
      ...current,
      phase: "cancelling",
      message: "Cancelling render and waiting for cleanup…",
    }));
    renderAbortRef.current.abort();
  };

  const retryRenderCleanup = async () => {
    const blocked = renderCleanupBlockedRef.current;

    if (
      blocked === null ||
      cleanupRetrying ||
      cleanupRetryInFlightRef.current
    ) {
      return;
    }

    cleanupRetryInFlightRef.current = true;
    setCleanupRetrying(true);
    const outcome = await retryBrowserRenderCleanup(blocked);
    cleanupRetryInFlightRef.current = false;
    setCleanupRetrying(false);

    if (outcome.kind === "cleanup-blocked") {
      renderCleanupBlockedRef.current = outcome;
      setRenderUi({
        phase: "cleanup-blocked",
        message:
          "Browser render storage is still busy. Cleanup remains blocked; retry again after the writer finishes releasing.",
        progress: null,
      });
      return;
    }

    renderCleanupBlockedRef.current = null;

    if (outcome.kind === "pre-cleanup-cleared") {
      renderSnapshotRef.current = null;
      setRenderLockStatus("checking");
      setRenderUi({
        phase: "idle",
        message:
          "Render storage cleanup completed. Start a new render when ready.",
        progress: null,
      });
      return;
    }

    const snapshot = renderSnapshotRef.current;
    renderSnapshotRef.current = null;

    if (snapshot === null) {
      setRenderUi({
        phase: "failure",
        message:
          "Render cleanup completed, but the frozen Story snapshot was unavailable.",
        progress: null,
      });
      return;
    }

    completeRenderOutcome(outcome, snapshot);
  };

  const exportActiveStory = () => {
    downloadText(
      serializeStorySource(activeStory),
      getYamlDownloadFilename(activeStory.title),
    );
  };

  const exportPendingVisualCandidate = () => {
    if (visual.kind !== "policy-rejected") {
      return;
    }

    downloadText(
      serializeStorySource(visual.candidate),
      getYamlDownloadFilename(visual.candidate.title),
    );
  };

  const exportPolicyRejectedImport = () => {
    if (policyRejectedImport === null) {
      return;
    }

    downloadText(
      policyRejectedImport.source,
      getYamlDownloadFilename(policyRejectedImport.story.title),
    );
  };

  const exportRecovery = () => {
    if (recovery === null) {
      return;
    }

    if (recovery.kind === "raw") {
      downloadText(
        recovery.raw,
        "tora-stored-recovery.txt",
      );
      return;
    }

    downloadText(
      serializeStorySource(recovery.story),
      getYamlDownloadFilename(recovery.story.title),
    );
  };

  const releaseRecovery = () => {
    if (recovery === null) {
      return true;
    }

    if (ownership.mode !== "owner") {
      setStorageWarning(
        "Persistence ownership is required before discarding protected recovery.",
      );
      return false;
    }

    try {
      window.localStorage.removeItem(PERSISTENCE_STORAGE_KEY);
      setRecovery(null);
      setDurableStory(null);
      setStorageWarning(null);
      return true;
    } catch (error) {
      setStorageWarning(
        error instanceof Error
          ? `Could not release stored recovery: ${error.message}`
          : "Could not release stored recovery.",
      );
      return false;
    }
  };

  const enterYamlFromActive = () => {
    setYamlState(createYamlStateFromActiveStory(activeStory));
    setAuthoringState(cleanAuthoringState(activeStory));
    setMode("yaml");
    setTransition(null);
  };

  const requestYamlMode = () => {
    if (visual.kind === "clean") {
      enterYamlFromActive();
      return;
    }

    setTransition({kind: "visual-to-yaml"});
  };

  const transferVisualCandidateToYaml = () => {
    if (visual.kind !== "policy-rejected") {
      return;
    }

    try {
      setYamlState(
        createYamlStateFromTransferredCandidate(
          activeStory,
          visual.candidate,
        ),
      );
    } catch (error) {
      setImportMessage(
        error instanceof Error
          ? `Candidate transfer blocked: ${error.message}`
          : "Candidate transfer blocked by browser YAML limits.",
      );
      return;
    }

    setAuthoringState(cleanAuthoringState(activeStory));
    setMode("yaml");
    setTransition(null);
  };

  const discardVisualAndEnterYaml = () => {
    enterYamlFromActive();
  };

  const applyCurrentYaml = (): boolean => {
    if (yamlState === null) {
      return false;
    }

    const applied = applyYamlState(yamlState);

    if (!applied.applied) {
      return false;
    }

    setYamlState(applied.state);
    setAuthoringState(cleanAuthoringState(applied.story));
    setVisualRevision((value) => value + 1);
    return true;
  };

  const requestVisualMode = () => {
    if (yamlState === null) {
      setMode("visual");
      return;
    }

    if (
      isYamlDirty(yamlState) ||
      yamlState.transferSnapshot !== null
    ) {
      setTransition({kind: "yaml-to-visual"});
      return;
    }

    setYamlState(null);
    setMode("visual");
    setVisualRevision((value) => value + 1);
  };

  const discardYamlAndEnterVisual = () => {
    setYamlState(null);
    setMode("visual");
    setTransition(null);
    setAuthoringState(cleanAuthoringState(activeStory));
    setVisualRevision((value) => value + 1);
  };

  const applyYamlAndEnterVisual = () => {
    if (!applyCurrentYaml()) {
      return;
    }

    setYamlState(null);
    setMode("visual");
    setTransition(null);
  };

  const exportCurrentYamlCandidate = () => {
    if (yamlState === null) {
      return;
    }

    const candidate = getYamlCandidateStory(yamlState);

    if (candidate === null) {
      return;
    }

    downloadText(
      yamlState.buffer,
      getYamlDownloadFilename(candidate.title),
    );
  };

  const commitImportedStory = (
    source: string,
    story: Story,
    targetMode: EditorMode,
  ) => {
    setAuthoringState(cleanAuthoringState(story));
    setVisualRevision((value) => value + 1);

    if (targetMode === "yaml") {
      const initial = createYamlStateFromActiveStory(story);
      const edited = tryEditYamlBuffer(initial, source);

      if (edited.accepted) {
        const validated = validateYamlBuffer(
          edited.state,
          "imported.yaml",
        );
        const applied = applyYamlState(validated);
        setYamlState(applied.applied ? applied.state : initial);
      } else {
        setYamlState(initial);
      }
    }

    setPolicyRejectedImport(null);
    setImportMessage(null);
    setTransition(null);
  };

  const importFile = async (file: File) => {
    const requestId = importRequestRef.current + 1;
    importRequestRef.current = requestId;

    // A new selection supersedes any previously staged import immediately,
    // even when the replacement fails before or during validation.
    setTransition((current) =>
      current?.kind === "import" ? null : current,
    );

    if (file.size > MAX_BROWSER_YAML_SOURCE_BYTES) {
      setImportMessage(
        "Import rejected before reading: file exceeds the 1 MiB browser limit.",
      );
      return;
    }

    let source: string;

    try {
      source = await file.text();
    } catch (error) {
      if (importRequestRef.current !== requestId) {
        return;
      }

      setImportMessage(
        error instanceof Error
          ? `Could not read import: ${error.message}`
          : "Could not read import.",
      );
      return;
    }

    if (importRequestRef.current !== requestId) {
      return;
    }

    const validation = evaluateYamlSource(source, file.name);

    if (validation.kind === "policy-rejected") {
      setPolicyRejectedImport({
        source,
        story: validation.story,
        filename: file.name,
        policyMessage: validation.policy.message,
      });
      setImportMessage(null);
      return;
    }

    if (validation.kind !== "eligible") {
      setImportMessage(
        validation.kind === "pending"
          ? "Import validation did not complete."
          : validation.message,
      );
      return;
    }

    const liveState = liveImportStateRef.current;

    if (liveState.lossRisk || liveState.recovery !== null) {
      setTransition({
        kind: "import",
        source,
        story: validation.story,
        filename: file.name,
      });
      return;
    }

    commitImportedStory(
      source,
      validation.story,
      liveState.mode,
    );
  };

  const confirmImport = () => {
    if (transition?.kind !== "import") {
      return;
    }

    if (recovery !== null && !releaseRecovery()) {
      return;
    }

    setConflict(null);
    setStorageWarning(null);
    commitImportedStory(
      transition.source,
      transition.story,
      liveImportStateRef.current.mode,
    );
  };

  const performReset = () => {
    if (recovery !== null && !releaseRecovery()) {
      return;
    }

    const fallback = getFallbackStory();
    setConflict(null);
    setStorageWarning(null);
    setPolicyRejectedImport(null);
    setAuthoringState(cleanAuthoringState(fallback));
    setYamlState(null);
    setMode("visual");
    setVisualRevision((value) => value + 1);
    setTransition(null);
    setImportMessage(null);
  };

  const requestReset = () => {
    if (lossRisk || recovery !== null) {
      setTransition({kind: "reset"});
      return;
    }

    performReset();
  };

  const reloadDurableConflict = () => {
    if (conflict === null) {
      return;
    }

    const reloadedStory =
      conflict.durableStory ?? getFallbackStory();

    setAuthoringState(cleanAuthoringState(reloadedStory));
    setYamlState(null);
    setMode("visual");
    setDurableStory(conflict.durableStory);
    setPolicyRejectedImport(null);
    setConflict(null);
    setStorageWarning(null);
    setVisualRevision((value) => value + 1);
  };

  const overwriteDurableConflict = () => {
    if (conflict === null || ownership.mode !== "owner") {
      return;
    }

    setConflict(null);
    setStorageWarning(null);
  };

  const renderTransitionPanel = () => {
    if (transition === null) {
      return null;
    }

    if (transition.kind === "visual-to-yaml") {
      if (visual.kind === "schema-invalid") {
        return (
          <div className="transition-panel" role="dialog">
            <strong>Visual draft is invalid.</strong>
            <span>
              Discard it to open YAML from the active Story, or stay in the visual editor.
            </span>
            <div>
              <button type="button" onClick={discardVisualAndEnterYaml}>
                Discard visual draft
              </button>
              <button type="button" onClick={() => setTransition(null)}>
                Stay in visual editor
              </button>
            </div>
          </div>
        );
      }

      if (visual.kind === "policy-rejected") {
        return (
          <div className="transition-panel" role="dialog">
            <strong>Visual candidate is valid but browser-ineligible.</strong>
            <span>{visual.policy.message}</span>
            <div>
              <button type="button" onClick={transferVisualCandidateToYaml}>
                Open candidate in YAML
              </button>
              <button type="button" onClick={discardVisualAndEnterYaml}>
                Discard visual candidate
              </button>
              <button type="button" onClick={() => setTransition(null)}>
                Stay in visual editor
              </button>
            </div>
          </div>
        );
      }
    }

    if (transition.kind === "yaml-to-visual" && yamlState !== null) {
      return (
        <div className="transition-panel" role="dialog">
          <strong>YAML has unapplied work.</strong>
          <span>
            Apply eligible YAML, discard the YAML draft, or stay in YAML.
          </span>
          <div>
            <button
              type="button"
              onClick={applyYamlAndEnterVisual}
              disabled={yamlState.validation.kind !== "eligible"}
            >
              Apply and open visual editor
            </button>
            <button type="button" onClick={discardYamlAndEnterVisual}>
              Discard YAML draft
            </button>
            <button type="button" onClick={() => setTransition(null)}>
              Stay in YAML
            </button>
          </div>
        </div>
      );
    }

    if (transition.kind === "import") {
      return (
        <div className="transition-panel" role="dialog">
          <strong>Import will discard current pending or recovery work.</strong>
          <span>Validated import: {transition.filename}</span>
          <div>
            <button type="button" onClick={confirmImport}>
              Discard current work and import
            </button>
            <button type="button" onClick={() => setTransition(null)}>
              Cancel import
            </button>
          </div>
        </div>
      );
    }

    if (transition.kind === "reset") {
      return (
        <div className="transition-panel" role="dialog">
          <strong>Reset will discard pending, unpersisted, or recovery state.</strong>
          <div>
            <button type="button" onClick={performReset}>
              Discard current state and reset
            </button>
            <button type="button" onClick={() => setTransition(null)}>
              Stay
            </button>
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div
      className="app-shell"
      data-editor-mode={mode}
      data-visual-state={visual.kind}
      data-visual-pending={String(visual.pending)}
      data-render-blocked={String(renderInputBlocked)}
      data-render-state={renderUi.phase}
      data-authoring-locked={String(authoringLocked)}
      data-loss-risk={String(lossRisk)}
      data-persistence-mode={ownership.mode}
    >
      <header className="app-header">
        <div>
          <p className="eyebrow">Local-first video authoring</p>
          <h1>Tora Video Engine</h1>
          <p className="subtitle">
            Visual and YAML authoring share one validated Story while local
            persistence remains protected by a single-writer browser lock.
          </p>
        </div>

        <div className="project-toolbar">
          <button
            type="button"
            onClick={mode === "visual" ? requestYamlMode : requestVisualMode}
            disabled={authoringLocked}
          >
            {mode === "visual" ? "Open YAML" : "Open visual editor"}
          </button>
          <button type="button" onClick={exportActiveStory}>
            Export active Story YAML
          </button>
          {visual.kind === "policy-rejected" ? (
            <button type="button" onClick={exportPendingVisualCandidate}>
              Export pending visual candidate YAML
            </button>
          ) : null}
          <label className="file-button">
            Import YAML
            <input
              type="file"
              accept=".yaml,.yml,application/x-yaml,text/yaml,text/plain"
              disabled={authoringLocked}
              onChange={(event) => {
                const file = event.target.files?.[0];

                if (file !== undefined) {
                  void importFile(file);
                }

                event.target.value = "";
              }}
            />
          </label>
          <button
            type="button"
            onClick={requestReset}
            disabled={authoringLocked}
          >
            Reset project
          </button>
          <button
            type="button"
            onClick={() => void startBrowserRender()}
            disabled={
              authoringLocked ||
              renderCapability?.kind !== "ready" ||
              renderLockStatus !== "available" ||
              renderInputBlocked ||
              renderUi.phase === "cleanup-blocked"
            }
          >
            Render MP4
          </button>
        </div>
      </header>

      {storageWarning !== null ? (
        <div className="app-banner warning-banner" role="status">
          <strong>Persistence warning</strong>
          <span>{storageWarning}</span>
          {ownership.mode !== "owner" ? (
            <button
              type="button"
              onClick={retryPersistenceOwnership}
              disabled={ownership.mode === "checking"}
            >
              {ownership.mode === "checking"
                ? "Checking persistence ownership"
                : "Retry persistence ownership"}
            </button>
          ) : null}
          <button type="button" onClick={exportActiveStory}>
            Export active Story YAML
          </button>
        </div>
      ) : null}

      {recovery !== null ? (
        <div className="app-banner recovery-banner" role="status">
          <strong>Stored recovery is protected</strong>
          <span>{recovery.message}</span>
          <button type="button" onClick={exportRecovery}>
            {recovery.kind === "raw"
              ? "Export stored raw data"
              : "Export stored project YAML"}
          </button>
          <button
            type="button"
            onClick={releaseRecovery}
            disabled={authoringLocked}
          >
            Discard stored project and continue
          </button>
        </div>
      ) : null}

      {conflict !== null ? (
        <div className="app-banner recovery-banner" role="dialog">
          <strong>Persistence conflict</strong>
          <span>
            {conflict.durableStory === null
              ? "Durable storage was cleared while this tab was secondary."
              : "Durable storage changed while this tab was secondary."}
          </span>
          <button
            type="button"
            onClick={reloadDurableConflict}
            disabled={authoringLocked}
          >
            Reload durable state
          </button>
          <button
            type="button"
            onClick={overwriteDurableConflict}
            disabled={authoringLocked}
          >
            Keep current in memory and overwrite
          </button>
          <button type="button" onClick={exportActiveStory}>
            Export current YAML
          </button>
        </div>
      ) : null}

      {policyRejectedImport !== null ? (
        <div
          className="app-banner warning-banner"
          role="status"
          data-import-candidate="policy-rejected"
        >
          <strong>Imported Story is valid but browser-ineligible</strong>
          <span>
            {policyRejectedImport.filename}: {policyRejectedImport.policyMessage}
          </span>
          <button type="button" onClick={exportPolicyRejectedImport}>
            Export imported YAML candidate
          </button>
          <button
            type="button"
            onClick={() => setPolicyRejectedImport(null)}
            disabled={authoringLocked}
          >
            Dismiss imported candidate
          </button>
        </div>
      ) : null}

      {importMessage !== null ? (
        <div className="app-banner warning-banner" role="status">
          {importMessage}
        </div>
      ) : null}

      <div
        className="app-banner render-banner"
        role="status"
        data-render-state={renderUi.phase}
      >
        <strong>Browser MP4</strong>
        <span>
          {renderCapability === null
            ? "Checking browser render support…"
            : renderCapability.kind === "unsupported"
              ? renderCapability.message
              : renderInputBlocked
                ? "Resolve or discard pending editor/import work before rendering the active Story."
                : renderLockStatus === "busy"
                  ? "Another Tora tab owns the browser render lock."
                  : renderLockStatus === "unavailable"
                    ? "Browser render lock status is unavailable. Preview, YAML export, and the local CLI remain available."
                    : renderUi.message}
        </span>
        {renderUi.progress !== null &&
        (renderUi.phase === "rendering" ||
          renderUi.phase === "cancelling") ? (
          <progress
            max={1}
            value={renderUi.progress}
            aria-label="Browser render progress"
          />
        ) : null}
        {renderCapability?.kind === "ready" &&
        (renderLockStatus === "busy" ||
          renderLockStatus === "unavailable") &&
        renderUi.phase !== "rendering" &&
        renderUi.phase !== "cancelling" &&
        renderUi.phase !== "cleanup-blocked" ? (
          <button
            type="button"
            onClick={() => void refreshRenderLockStatus()}
          >
            Retry render availability
          </button>
        ) : null}
        {renderUi.phase === "rendering" ? (
          <button type="button" onClick={cancelBrowserRender}>
            Cancel Render
          </button>
        ) : null}
        {renderUi.phase === "cancelling" ? (
          <button type="button" disabled>
            Cancelling…
          </button>
        ) : null}
        {renderUi.phase === "cleanup-blocked" ? (
          <button
            type="button"
            onClick={() => void retryRenderCleanup()}
            disabled={cleanupRetrying}
          >
            {cleanupRetrying ? "Retrying cleanup…" : "Retry cleanup"}
          </button>
        ) : null}
      </div>

      {renderTransitionPanel()}

      <main className="app-main editor-workspace">
        <fieldset
          className="authoring-fieldset"
          disabled={authoringLocked}
          aria-label="Story authoring"
        >
        {mode === "visual" ? (
          <VisualEditor
            key={visualRevision}
            activeStory={activeStory}
            onEvaluationChange={onVisualEvaluationChange}
          />
        ) : yamlState !== null ? (
          <YamlEditor
            activeStory={activeStory}
            state={yamlState}
            onStateChange={setYamlState}
            onApply={applyCurrentYaml}
            onRequestVisual={requestVisualMode}
            onExportActive={exportActiveStory}
            onExportCandidate={exportCurrentYamlCandidate}
            onImportFile={importFile}
          />
        ) : null}
        </fieldset>

        <section
          className="preview-card preview-sticky"
          aria-labelledby="preview-heading"
        >
          <div className="preview-card-header">
            <div>
              <p className="section-kicker">Active validated Story</p>
              <h2 id="preview-heading">{activeStory.title}</h2>
            </div>
            <span className="format-badge">
              {previewConfig.compositionWidth}×
              {previewConfig.compositionHeight} · {previewConfig.fps} FPS
            </span>
          </div>

          <Preview story={activeStory} />
        </section>
      </main>
    </div>
  );
};
