import {useCallback, useState} from "react";
import {exampleStory} from "../story/exampleStory.ts";
import type {Story} from "../story/types.ts";
import {
  applyVisualDraftEvaluation,
  createAuthoringState,
} from "./authoringState.ts";
import {evaluateBrowserStoryPolicy} from "./browserPolicy.ts";
import {Preview} from "./components/Preview.tsx";
import {VisualEditor} from "./components/VisualEditor.tsx";
import {getWebPlayerConfig} from "./previewConfig.ts";
import type {VisualDraftEvaluation} from "./visualDraft.ts";

const getInitialActiveStory = (): Story => {
  const policy = evaluateBrowserStoryPolicy(exampleStory);

  if (!policy.eligible) {
    throw new Error(
      `Canonical example Story is not browser-eligible: ${policy.message}`,
    );
  }

  return structuredClone(exampleStory);
};

export const App = () => {
  const [authoringState, setAuthoringState] = useState(() =>
    createAuthoringState(getInitialActiveStory()),
  );
  const {activeStory, visual} = authoringState;
  const previewConfig = getWebPlayerConfig(activeStory);

  const onVisualEvaluationChange = useCallback(
    (evaluation: VisualDraftEvaluation) => {
      setAuthoringState((current) =>
        applyVisualDraftEvaluation(current, evaluation),
      );
    },
    [],
  );

  return (
    <div
      className="app-shell"
      data-visual-state={visual.kind}
      data-visual-pending={String(visual.pending)}
    >
      <header className="app-header">
        <div>
          <p className="eyebrow">Local-first video authoring</p>
          <h1>Tora Video Engine</h1>
          <p className="subtitle">
            Build a validated Story visually while the production Remotion
            composition remains the single preview contract.
          </p>
        </div>
      </header>

      <main className="app-main editor-workspace">
        <VisualEditor
          activeStory={activeStory}
          onEvaluationChange={onVisualEvaluationChange}
        />

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
