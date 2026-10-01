import {
  useCallback,
  useEffect,
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
  downloadText,
  getYamlDownloadFilename,
} from "./downloads.ts";
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
  durableStory: Story;
};

type InitialProject = {
  activeStory: Story;
  durableStory: Story | null;
  recovery: ProtectedRecovery | null;
  storageWarning: string | null;
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
  const [importMessage, setImportMessage] = useState<string | null>(null);

  const {activeStory, visual} = authoringState;
  const previewConfig = getWebPlayerConfig(activeStory);

  const activeStoryChangedFromInitial =
    !storiesSemanticallyEqual(initialProject.activeStory, activeStory);

  const activeStoryDurable =
    (ownership.mode === "owner" &&
      recovery === null &&
      conflict === null &&
      storiesSemanticallyEqual(durableStory, activeStory)) ||
    (!activeStoryChangedFromInitial &&
      (recovery !== null ||
        ownership.mode === "secondary" ||
        ownership.mode === "session-only" ||
        ownership.mode === "checking"));

  const lossRisk = hasLossRisk({
    visual,
    yaml: yamlState,
    recovery,
    activeStoryDurable,
  });

  const renderBlocked =
    visual.pending ||
    (yamlState !== null &&
      (isYamlDirty(yamlState) ||
        yamlState.transferSnapshot !== null));

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
      if (ownership.mode !== "owner" || recovery !== null || conflict !== null) {
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
    [conflict, ownership.mode, recovery],
  );

  useEffect(() => {
    if (
      ownership.mode === "owner" &&
      recovery === null &&
      conflict === null &&
      !storiesSemanticallyEqual(durableStory, activeStory)
    ) {
      persistStory(activeStory);
    }
  }, [
    activeStory,
    conflict,
    durableStory,
    ownership.mode,
    persistStory,
    recovery,
  ]);

  useEffect(() => {
    if (!lossRisk) {
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
  }, [lossRisk]);

  const adoptOwnership = useCallback(
    async (lease: PersistenceOwnership) => {
      if (lease.mode !== "owner") {
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

        setOwnership(lease);

        if (current.recovery !== null) {
          setRecovery(current.recovery);
          setDurableStory(null);
          setStorageWarning(
            "Stored recovery is protected. Autosave is suspended until it is explicitly discarded.",
          );
          return;
        }

        if (
          current.durableStory !== null &&
          !storiesSemanticallyEqual(current.durableStory, activeStory)
        ) {
          setDurableStory(current.durableStory);
          setConflict({durableStory: current.durableStory});
          setStorageWarning(
            "Durable storage changed while this tab did not own persistence.",
          );
          return;
        }

        setDurableStory(current.durableStory);
        setStorageWarning(null);
      } catch (error) {
        setOwnership(lease);
        setStorageWarning(
          error instanceof Error
            ? `Persistence ownership acquired, but storage could not be reread: ${error.message}`
            : "Persistence ownership acquired, but storage could not be reread.",
        );
      }
    },
    [activeStory],
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

        setOwnership(next);

        if (current.recovery !== null) {
          setRecovery(current.recovery);
          setDurableStory(null);
          setStorageWarning(
            "Stored recovery is protected. Autosave is suspended until it is explicitly discarded.",
          );
          return;
        }

        if (
          current.durableStory !== null &&
          !storiesSemanticallyEqual(
            current.durableStory,
            initialProject.activeStory,
          )
        ) {
          setDurableStory(current.durableStory);
          setConflict({durableStory: current.durableStory});
          setStorageWarning(
            "Durable storage changed before persistence ownership was acquired.",
          );
          return;
        }

        setDurableStory(current.durableStory);
        setStorageWarning(null);
      } catch (error) {
        setOwnership(next);
        setStorageWarning(
          error instanceof Error
            ? `Persistence ownership acquired, but storage could not be reread: ${error.message}`
            : "Persistence ownership acquired, but storage could not be reread.",
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

  const retryPersistenceOwnership = async () => {
    if (ownership.mode === "owner") {
      return;
    }

    const lease = await acquirePersistenceOwnership(navigator.locks);
    await adoptOwnership(lease);
  };

  const exportActiveStory = () => {
    downloadText(
      serializeStorySource(activeStory),
      getYamlDownloadFilename(activeStory.title),
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

    setYamlState(
      createYamlStateFromTransferredCandidate(
        activeStory,
        visual.candidate,
      ),
    );
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
  ) => {
    setAuthoringState(cleanAuthoringState(story));
    setVisualRevision((value) => value + 1);

    if (mode === "yaml") {
      const initial = createYamlStateFromActiveStory(story);
      const edited = tryEditYamlBuffer(initial, source);

      if (edited.accepted) {
        const applied = applyYamlState(edited.state);
        setYamlState(applied.applied ? applied.state : initial);
      } else {
        setYamlState(initial);
      }
    }

    setImportMessage(null);
    setTransition(null);
  };

  const importFile = async (file: File) => {
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
      setImportMessage(
        error instanceof Error
          ? `Could not read import: ${error.message}`
          : "Could not read import.",
      );
      return;
    }

    const validation = evaluateYamlSource(source, file.name);

    if (validation.kind !== "eligible") {
      setImportMessage(
        validation.kind === "policy-rejected"
          ? `Import is valid for CLI but browser-ineligible: ${validation.policy.message}`
          : validation.message,
      );
      return;
    }

    if (lossRisk || recovery !== null) {
      setTransition({
        kind: "import",
        source,
        story: validation.story,
        filename: file.name,
      });
      return;
    }

    commitImportedStory(source, validation.story);
  };

  const confirmImport = () => {
    if (transition?.kind !== "import") {
      return;
    }

    if (recovery !== null && !releaseRecovery()) {
      return;
    }

    commitImportedStory(transition.source, transition.story);
  };

  const performReset = () => {
    if (recovery !== null && !releaseRecovery()) {
      return;
    }

    const fallback = getFallbackStory();
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

    setAuthoringState(cleanAuthoringState(conflict.durableStory));
    setYamlState(null);
    setMode("visual");
    setDurableStory(conflict.durableStory);
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
      data-render-blocked={String(renderBlocked)}
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
          >
            {mode === "visual" ? "Open YAML" : "Open visual editor"}
          </button>
          <button type="button" onClick={exportActiveStory}>
            Export active Story YAML
          </button>
          <label className="file-button">
            Import YAML
            <input
              type="file"
              accept=".yaml,.yml,application/x-yaml,text/yaml,text/plain"
              onChange={(event) => {
                const file = event.target.files?.[0];

                if (file !== undefined) {
                  void importFile(file);
                }

                event.target.value = "";
              }}
            />
          </label>
          <button type="button" onClick={requestReset}>
            Reset project
          </button>
        </div>
      </header>

      {storageWarning !== null ? (
        <div className="app-banner warning-banner" role="status">
          <strong>Persistence warning</strong>
          <span>{storageWarning}</span>
          {ownership.mode !== "owner" ? (
            <button type="button" onClick={retryPersistenceOwnership}>
              Retry persistence ownership
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
          <button type="button" onClick={releaseRecovery}>
            Discard stored project and continue
          </button>
        </div>
      ) : null}

      {conflict !== null ? (
        <div className="app-banner recovery-banner" role="dialog">
          <strong>Persistence conflict</strong>
          <span>Durable storage changed while this tab was secondary.</span>
          <button type="button" onClick={reloadDurableConflict}>
            Reload durable project
          </button>
          <button type="button" onClick={overwriteDurableConflict}>
            Keep current in memory and overwrite
          </button>
          <button type="button" onClick={exportActiveStory}>
            Export current YAML
          </button>
        </div>
      ) : null}

      {importMessage !== null ? (
        <div className="app-banner warning-banner" role="status">
          {importMessage}
        </div>
      ) : null}

      {renderTransitionPanel()}

      <main className="app-main editor-workspace">
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
