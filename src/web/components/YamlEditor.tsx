import type {ChangeEvent} from "react";
import type {Story} from "../../story/types.ts";
import {
  canExportYamlCandidate,
  getYamlCandidateStory,
  isYamlDirty,
  tryEditYamlBuffer,
  type YamlEditorState,
} from "../yamlState.ts";

type YamlEditorProps = {
  activeStory: Story;
  state: YamlEditorState;
  onStateChange: (state: YamlEditorState) => void;
  onApply: () => void;
  onRequestVisual: () => void;
  onExportActive: () => void;
  onExportCandidate: () => void;
  onImportFile: (file: File) => void;
};

const validationMessage = (state: YamlEditorState): string => {
  if (state.sourceGuardMessage !== null) {
    return state.sourceGuardMessage;
  }

  switch (state.validation.kind) {
    case "eligible":
      return "YAML is schema-valid and browser-eligible.";
    case "policy-rejected":
      return `Valid Story for CLI/engine, but browser-ineligible: ${state.validation.policy.message}`;
    case "parse-invalid":
    case "schema-invalid":
    case "source-oversized":
      return state.validation.message;
  }
};

export const YamlEditor = ({
  activeStory,
  state,
  onStateChange,
  onApply,
  onRequestVisual,
  onExportActive,
  onExportCandidate,
  onImportFile,
}: YamlEditorProps) => {
  const dirty = isYamlDirty(state);
  const candidate = getYamlCandidateStory(state);
  const canApply = state.validation.kind === "eligible";
  const canExportCandidate = canExportYamlCandidate(state);

  const onBufferChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const result = tryEditYamlBuffer(state, event.target.value);
    onStateChange(result.state);
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (file !== undefined) {
      onImportFile(file);
    }

    event.target.value = "";
  };

  return (
    <section className="editor-card yaml-editor" aria-labelledby="yaml-heading">
      <div className="editor-heading-row">
        <div>
          <p className="section-kicker">Portable Story source</p>
          <h2 id="yaml-heading">YAML</h2>
        </div>
        <span
          className={dirty ? "status-badge status-pending" : "status-badge"}
          data-yaml-dirty={String(dirty)}
        >
          {dirty ? "Unapplied changes" : "Applied / clean"}
        </span>
      </div>

      <div className="yaml-toolbar">
        <button
          type="button"
          onClick={onApply}
          disabled={!canApply || !dirty}
        >
          Apply YAML
        </button>
        <button type="button" onClick={onRequestVisual}>
          Visual editor
        </button>
        <button type="button" onClick={onExportActive}>
          Export active Story YAML
        </button>
        <button
          type="button"
          onClick={onExportCandidate}
          disabled={!canExportCandidate}
        >
          Export current YAML candidate
        </button>
        <label className="file-button">
          Import YAML
          <input
            type="file"
            accept=".yaml,.yml,application/x-yaml,text/yaml,text/plain"
            onChange={onFileChange}
          />
        </label>
      </div>

      <label className="field yaml-source-field">
        <span>YAML source</span>
        <textarea
          aria-label="YAML source"
          spellCheck={false}
          value={state.buffer}
          onChange={onBufferChange}
        />
      </label>

      <div
        className={
          state.validation.kind === "eligible"
            ? "yaml-validation"
            : "yaml-validation yaml-validation-error"
        }
        data-yaml-validation={state.validation.kind}
        role="status"
      >
        <strong>{state.validation.kind}</strong>
        <span>{validationMessage(state)}</span>
        {candidate !== null ? (
          <small>Candidate title: {candidate.title}</small>
        ) : null}
      </div>

      <div className="yaml-baseline-note">
        Preview remains on <strong>{activeStory.title}</strong> until eligible
        YAML is explicitly applied.
      </div>
    </section>
  );
};
