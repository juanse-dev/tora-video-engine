# WEB-006 shared renderer compatibility audit

This audit applies to the render-critical component tree used by Player, CLI, and `@remotion/web-renderer@4.0.529`.

## Shared tree

`ToraVideo → StoryRenderer → Scene → Background / Tora / Caption`

There is no browser-only canvas renderer and no screenshot path from the visible Player.

## Component audit

| Component | Render-critical behavior | WEB-006 compatibility decision |
| --- | --- | --- |
| `ToraVideo` | font readiness and error boundary | Uses supported flex/layout, font and background-color primitives. Client-side render font failure calls Remotion cancellation rather than relying on the visual fallback. |
| `StoryRenderer` | scene order and timing | Uses Remotion `Sequence` and the existing render plan; no CSS layering shortcut. |
| `Scene` | scene clipping, overlays, placement, transforms | DOM order is back-to-front; no `z-index`. Uses supported overflow, transforms, transform origin, opacity and background-color. |
| `Background` | full-frame raster background | Uses Remotion `Img` and supported `object-fit: cover`. |
| `Tora` | transparent pose raster | Uses Remotion `Img` and supported `object-fit: contain`. The previous `object-position` dependency was removed because 4.0.529 does not support it. |
| `Caption` | alignment, wrapping, clipping, typography | No `text-align`, `overflow-wrap`, `word-break`, or `box-sizing` dependency. Lines are calculated explicitly in shared TypeScript and rendered as ordered line elements. Center/left placement uses flex geometry. |

## Caption layout contract

`layoutCaptionLines()` is shared by all render paths. It:

- chooses line breaks before React renders the caption;
- prefers whitespace boundaries for natural-language text;
- hard-splits overlong tokens deterministically;
- uses the same explicit line list for Player, CLI and web-renderer;
- derives font size from the resulting line count and the shared caption height budget.

The outer caption geometry is fixed and the inner padding creates a conservative 864 px text-content budget. Every calculated line is constrained to that budget by the shared width estimator.

Browser regression fixtures cover:

- centered caption;
- left-aligned caption;
- long natural-language wrapping;
- long unbroken-token wrapping.

Unit source-audit tests fail if unsupported alignment/wrapping properties are reintroduced.

## Known renderer constraints

WEB-006 intentionally keeps Remotion's normal DOM-composer path:

`allowHtmlInCanvas: false`

The experimental HTML-in-canvas mode is not used as a parity escape hatch.

The audit is pinned to Remotion 4.0.529. Updating Remotion requires re-reading that version's client-side rendering limitations and rerunning the compatibility/golden suite before browser MP4 export is considered verified.
