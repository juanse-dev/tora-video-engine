import {useEffect, useMemo, useState} from "react";
import type {Story} from "../../story/types.ts";
import {AssetCatalog} from "./AssetCatalog.tsx";
import {
  addVisualScene,
  canAddVisualScene,
  deleteVisualScene,
  evaluateVisualDraft,
  moveVisualScene,
  storyToVisualDraft,
  updateVisualScene,
  validateRawVisualCaption,
  validateRawVisualTitle,
  visualEditorOptions,
  type VisualDraftEvaluation,
  type VisualSceneDraft,
  type VisualStoryDraft,
} from "../visualDraft.ts";

type VisualEditorProps = {
  activeStory: Story;
  onEvaluationChange: (evaluation: VisualDraftEvaluation) => void;
};

const removeError = (
  errors: Record<string, string>,
  path: string,
): Record<string, string> => {
  const next = {...errors};
  delete next[path];
  return next;
};

export const VisualEditor = ({
  activeStory,
  onEvaluationChange,
}: VisualEditorProps) => {
  const [draft, setDraft] = useState<VisualStoryDraft>(() =>
    storyToVisualDraft(activeStory),
  );
  const [selectedScene, setSelectedScene] = useState(0);
  const [rawGuardErrors, setRawGuardErrors] = useState<
    Record<string, string>
  >({});

  const evaluation = useMemo(() => evaluateVisualDraft(draft), [draft]);
  const errors = {
    ...evaluation.errors,
    ...rawGuardErrors,
  };
  const selected = draft.scenes[selectedScene] ?? draft.scenes[0];

  useEffect(() => {
    onEvaluationChange(evaluation);
  }, [evaluation, onEvaluationChange]);

  const updateScene = (
    index: number,
    patch: Partial<VisualSceneDraft>,
  ) => {
    setDraft((current) => updateVisualScene(current, index, patch));
  };

  const updateTitle = (title: string) => {
    const error = validateRawVisualTitle(title);

    if (error !== null) {
      setRawGuardErrors((current) => ({
        ...current,
        title: error,
      }));
      return;
    }

    setRawGuardErrors((current) => removeError(current, "title"));
    setDraft((current) => ({
      ...current,
      title,
    }));
  };

  const updateCaption = (text: string) => {
    const path = `scenes.${selectedScene}.text`;
    const error = validateRawVisualCaption(text);

    if (error !== null) {
      setRawGuardErrors((current) => ({
        ...current,
        [path]: error,
      }));
      return;
    }

    setRawGuardErrors((current) => removeError(current, path));
    updateScene(selectedScene, {text});
  };

  const addScene = () => {
    if (!canAddVisualScene(draft)) {
      return;
    }

    const next = addVisualScene(draft);
    setDraft(next);
    setSelectedScene(next.scenes.length - 1);
  };

  const deleteScene = () => {
    const next = deleteVisualScene(draft, selectedScene);

    if (next === draft) {
      return;
    }

    setDraft(next);
    setSelectedScene(Math.min(selectedScene, next.scenes.length - 1));
    setRawGuardErrors({});
  };

  const moveScene = (offset: -1 | 1) => {
    const target = selectedScene + offset;
    const next = moveVisualScene(draft, selectedScene, target);

    if (next === draft) {
      return;
    }

    setDraft(next);
    setSelectedScene(target);
    setRawGuardErrors({});
  };

  const discardPendingChanges = () => {
    setDraft(storyToVisualDraft(activeStory));
    setSelectedScene((current) =>
      Math.min(current, activeStory.scenes.length - 1),
    );
    setRawGuardErrors({});
  };

  const pending = evaluation.kind !== "eligible";

  return (
    <section className="editor-card" aria-labelledby="editor-heading">
      <div className="editor-heading-row">
        <div>
          <p className="section-kicker">Visual editor</p>
          <h2 id="editor-heading">Story</h2>
        </div>
        <span
          className={pending ? "status-badge status-pending" : "status-badge"}
          data-editor-status={evaluation.kind}
        >
          {pending ? "Pending draft" : "Preview up to date"}
        </span>
      </div>

      {pending ? (
        <div className="editor-warning" role="status">
          <strong>Preview shows the last valid Story.</strong>
          <span>
            {evaluation.kind === "policy-rejected"
              ? evaluation.policy.message
              : "Fix the highlighted fields or discard the pending draft."}
          </span>
          <button type="button" onClick={discardPendingChanges}>
            Discard pending changes
          </button>
        </div>
      ) : null}

      <label className="field">
        <span>Title</span>
        <input
          value={draft.title}
          onChange={(event) => updateTitle(event.target.value)}
          aria-invalid={Boolean(errors.title)}
          aria-describedby={errors.title ? "title-error" : undefined}
        />
        {errors.title ? (
          <small id="title-error" className="field-error">
            {errors.title}
          </small>
        ) : null}
      </label>

      <div className="scene-editor-layout">
        <aside className="scene-list" aria-label="Scenes">
          <div className="scene-list-header">
            <strong>Scenes ({draft.scenes.length})</strong>
            <button
              type="button"
              onClick={addScene}
              disabled={!canAddVisualScene(draft)}
            >
              Add scene
            </button>
          </div>

          <div className="scene-list-items">
            {draft.scenes.map((scene, index) => (
              <button
                type="button"
                key={index}
                className={
                  index === selectedScene
                    ? "scene-list-item selected"
                    : "scene-list-item"
                }
                onClick={() => setSelectedScene(index)}
                aria-pressed={index === selectedScene}
              >
                <span>{index + 1}</span>
                <span>
                  <strong>{scene.type}</strong>
                  <small>{scene.text || "Untitled scene"}</small>
                </span>
              </button>
            ))}
          </div>
        </aside>

        {selected ? (
          <div className="scene-form">
            <div className="scene-form-toolbar">
              <strong>Scene {selectedScene + 1}</strong>
              <div>
                <button
                  type="button"
                  onClick={() => moveScene(-1)}
                  disabled={selectedScene === 0}
                  aria-label="Move scene up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveScene(1)}
                  disabled={selectedScene === draft.scenes.length - 1}
                  aria-label="Move scene down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={deleteScene}
                  disabled={draft.scenes.length === 1}
                >
                  Delete
                </button>
              </div>
            </div>

            <div className="field-grid">
              <label className="field">
                <span>Type</span>
                <select
                  value={selected.type}
                  onChange={(event) =>
                    updateScene(selectedScene, {
                      type: event.target.value as VisualSceneDraft["type"],
                    })
                  }
                >
                  {visualEditorOptions.sceneTypes.map((type) => (
                    <option value={type} key={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <AssetCatalog
              scene={selected}
              onChange={(patch) =>
                updateScene(selectedScene, patch)
              }
            />

            <label className="field">
              <span>Caption</span>
              <textarea
                rows={4}
                value={selected.text}
                onChange={(event) => updateCaption(event.target.value)}
                aria-invalid={Boolean(
                  errors[`scenes.${selectedScene}.text`],
                )}
              />
              {errors[`scenes.${selectedScene}.text`] ? (
                <small className="field-error">
                  {errors[`scenes.${selectedScene}.text`]}
                </small>
              ) : null}
            </label>

            <label className="field">
              <span>Duration (seconds)</span>
              <input
                type="number"
                step="0.1"
                min="0"
                value={selected.duration}
                onChange={(event) =>
                  updateScene(selectedScene, {
                    duration: event.target.value,
                  })
                }
                aria-invalid={Boolean(
                  errors[`scenes.${selectedScene}.duration`],
                )}
              />
              {errors[`scenes.${selectedScene}.duration`] ? (
                <small className="field-error">
                  {errors[`scenes.${selectedScene}.duration`]}
                </small>
              ) : null}
            </label>
          </div>
        ) : null}
      </div>
    </section>
  );
};
