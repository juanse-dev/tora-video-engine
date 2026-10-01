import {Preview} from "./components/Preview.tsx";

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
              <h2 id="preview-heading">Deploy Friday</h2>
            </div>
            <span className="format-badge">9:16 · 30 FPS</span>
          </div>

          <Preview />
        </section>
      </main>
    </div>
  );
};
