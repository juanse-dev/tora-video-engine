/**
 * Records every `data-render-state` value the app shell goes through.
 *
 * Cancel Render can settle in a fraction of a second, so the transient
 * `cancelling` state may be gone before an assertion polls for it. Install the
 * recorder before the action, then read the sequence afterwards. Only the
 * states entered after installation are recorded, so a state left over from an
 * earlier render (such as `success`) is not part of the sequence.
 */
export const recordRenderStates = (page) =>
  page.evaluate(() => {
    const target = document.querySelector(".app-shell");
    const seen = [];
    let last = target.getAttribute("data-render-state");

    window.__renderStates = seen;
    new MutationObserver(() => {
      const state = target.getAttribute("data-render-state");

      if (state !== last) {
        last = state;
        seen.push(state);
      }
    }).observe(target, {
      attributes: true,
      attributeFilter: ["data-render-state"],
    });
  });

export const readRenderStates = (page) =>
  page.evaluate(() => window.__renderStates);
