/**
 * Runs inside the page (`page.evaluate`), so it must stay self-contained: it
 * uses only the page globals. Exported separately so a Node unit test can run
 * it against a fake DOM.
 *
 * It records the states the shell enters after installation. The observer
 * callback is batched, so React can go `cancelling` -> `idle` before it runs;
 * every record carries the attribute's old value, which lets the batch be
 * replayed: the old value of record N+1 is the state record N entered, and the
 * current attribute is the state the last record entered. The value before the
 * first record is the starting state and is not "entered".
 */
export function installRenderStateRecorder() {
  const attribute = "data-render-state";
  const target = document.querySelector(".app-shell");
  const seen = [];
  let last = target.getAttribute(attribute);

  window.__renderStates = seen;
  new MutationObserver((records) => {
    const entered = [
      ...records.slice(1).map((record) => record.oldValue),
      target.getAttribute(attribute),
    ];

    for (const state of entered) {
      if (state !== last) {
        last = state;
        seen.push(state);
      }
    }
  }).observe(target, {
    attributes: true,
    attributeFilter: [attribute],
    attributeOldValue: true,
  });
}

/**
 * Records every `data-render-state` value the app shell goes through.
 *
 * Cancel Render can settle in a fraction of a second, so the transient
 * `cancelling` state may be gone before an assertion polls for it. Install the
 * recorder before the action, then read the sequence afterwards. Only states
 * entered after installation are recorded, so a state left over from an
 * earlier render (such as `success`) is not part of the sequence.
 */
export const recordRenderStates = (page) =>
  page.evaluate(installRenderStateRecorder);

export const readRenderStates = (page) =>
  page.evaluate(() => window.__renderStates);
