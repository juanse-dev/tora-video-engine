import {exampleStory} from "../story/exampleStory.ts";
import {Preview} from "./components/Preview.tsx";
import {getWebPlayerConfig} from "./previewConfig.ts";

const previewConfig = getWebPlayerConfig(exampleStory);

export const App = () => {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Local-first video authoring</p>
          <h1>Tora Video Engine</h1>
          <p className="subtitle">
            Browser preview of the canonical Tora story using the production
            Remotion composition.
          </p>
        </div>
      </header>

      <main className="app-main">
        <section className="preview-card" aria-labelledby="preview-heading">
          <div className="preview-card-header">
            <div>
              <p className="section-kicker">Canonical story</p>
              <h2 id="preview-heading">{exampleStory.title}</h2>
            </div>
            <span className="format-badge">
              {previewConfig.compositionWidth}×
              {previewConfig.compositionHeight} · {previewConfig.fps} FPS
            </span>
          </div>

          <Preview story={exampleStory} />
        </section>
      </main>
    </div>
  );
};
