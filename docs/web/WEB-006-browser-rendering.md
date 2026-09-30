# WEB-006 — Browser-side MP4 rendering

> Status: **Proposed**

## Goal

Render the current validated Story to an H.264 MP4 entirely in the user's browser and make the result downloadable.

## User-visible outcome

The user clicks **Renderizar MP4**, sees render state/progress, and receives a downloadable vertical MP4 without a Tora application backend.

## Technology boundary

Use \`@remotion/web-renderer\` at the same exact Remotion version as the repository.

The renderer must consume the existing composition directly:

~~~text
Validated Story
      ↓
existing ToraVideo component
      ↓
existing metadata / dimensions / FPS
      ↓
renderMediaOnWeb()
      ↓
H.264 MP4 Blob
      ↓
browser download
~~~

Do not render screenshots from the visible Player or maintain a parallel canvas renderer.

## Capability detection

Client-side rendering depends on browser WebCodecs and codec/container support.

Before enabling the render action, check whether the requested H.264/MP4 configuration can be rendered in the current browser using the capability API provided by the pinned Remotion version.

If unsupported:

- do not start the render;
- explain that browser rendering is unavailable;
- keep editing and preview usable;
- mention the existing local CLI as the alternative.

Do not add a server fallback in this spec.

## Render configuration

The web export must reuse:

- \`ToraVideo\`;
- current validated Story as input props;
- \`VIDEO_WIDTH\`;
- \`VIDEO_HEIGHT\`;
- \`VIDEO_FPS\`;
- derived duration from the existing Story metadata/timeline.

Target output:

- MP4 container;
- H.264 video;
- 1080 × 1920;
- 30 FPS.

Any web-renderer API options required for the installed Remotion version should be implemented according to that exact version.

## Browser render budget

Schema validity is necessary but not sufficient for safe browser rendering.

The shared `StorySchema` intentionally remains environment-agnostic and allows any duration whose derived frame count is a safe positive integer. Do not tighten that contract solely for the web UI, because the local CLI may reasonably support workloads outside the browser MVP.

For v0.2, define a browser-only export budget:

- maximum total duration: **300 seconds**;
- equivalent maximum at the fixed 30 FPS: **9,000 frames**.

Compute eligibility from the same derived total duration/frame metadata used by the renderer, not by introducing a second timing calculation.

A valid Story above this limit:

- remains valid for the shared engine/CLI;
- is already prevented by the WEB-003/WEB-005 browser authoring policy from replacing the active live Story when it exceeds the shared 9,000-frame authoring ceiling;
- must have browser MP4 export disabled;
- must show an explanation that the Story exceeds the v0.2 browser render limit;
- should point to the local CLI as the alternative render path.

Keep this limit named/centralized so it can be revisited later based on real browser performance without changing the Story schema.

## Render eligibility

The primary render action must only be enabled when all of the following are true:

- the current browser supports the requested H.264/MP4 render configuration;
- the visual editor has no pending candidate that differs from the active Story, whether schema-invalid or browser-policy-ineligible;
- the YAML editor has no unapplied buffer changes;
- an active validated Story that has already passed the browser authoring/preview budget is available;
- the Story's derived total duration/frame count is within the v0.2 browser render budget.

If either editor has pending content that is not the active Story—schema-invalid visual input, browser-policy-rejected visual input, or unapplied YAML—do not offer to render the older active Story behind it. Disable the action and explain what must be fixed, reduced into budget, transferred, applied, or discarded first.

If the Story is valid but exceeds the browser render budget, disable only browser MP4 export and explain that this is a browser resource constraint rather than a Story validation error.

## Render UI state

At minimum expose:

- idle;
- rendering;
- success;
- failure.

While rendering:

- prevent accidental duplicate concurrent renders from the primary button;
- surface available progress information from the renderer;
- keep an understandable status if progress is coarse;
- lock every control that can change either the validated Story or an editor draft, including visual fields, asset selection, scene add/delete/reorder, YAML editing/apply/import, reset, and editor-mode transitions;
- allow non-mutating interactions such as preview playback if they do not affect the render input;
- unlock authoring only after the render has succeeded, failed, or been explicitly cancelled if cancellation is supported.

The render must capture one immutable Story snapshot at start. The UI lock ensures that the visible authoring state remains the same snapshot for the lifetime of the render, so a successful download cannot silently represent an older Story than the editor currently shows.

Do not auto-download an output after authoring state has somehow diverged from the render snapshot. This should be unreachable under the required lock; treat any such divergence as a safety assertion/failure rather than presenting the Blob as current.

## Download

When rendering succeeds:

- obtain the Blob from the web renderer;
- create a temporary object URL;
- trigger/download using a deterministic \`.mp4\` filename;
- revoke temporary URLs when they are no longer needed.

A failed render must not present an old Blob as the new successful result.

## Compatibility verification

The canonical Story is the golden web-render test.

Verify that browser output has:

- H.264 MP4;
- 1080 × 1920 dimensions;
- 30 FPS where metadata inspection makes this available;
- 12-second duration / 360 frames for the canonical fixture;
- expected scene order, assets, captions, and animations.

The CLI and browser render do not need byte-identical MP4 files. They must be semantically equivalent outputs from the same Story/render plan.

## Telemetry note

Remotion's client-side rendering may emit Remotion telemetry according to the upstream package behavior. Tora Video Engine must not add its own analytics requirement to complete a render in v0.2.

## Acceptance criteria

- supported browsers can render the canonical Story to an H.264 MP4;
- render happens in-browser without Tora server/serverless render infrastructure;
- capability is checked before rendering;
- MP4 rendering is disabled whenever the visual editor has any pending candidate not reflected by the active Story (schema-invalid or browser-policy-ineligible) or YAML contains unapplied changes, preventing accidental export of a stale active Story;
- a Story at or below 300 seconds / 9,000 frames remains eligible when all other requirements pass;
- a valid Story above 300 seconds / 9,000 frames is rejected only by browser render eligibility, with a clear CLI alternative;
- unsupported browsers receive a useful message and can still edit/preview;
- render uses an immutable validated Story snapshot;
- all Story/draft-mutating authoring controls remain locked from render start through success/failure/cancel;
- a completed render cannot auto-download as the current result if authoring state diverged from its snapshot;
- final filename is deterministic;
- output timing/dimensions match the engine configuration;
- local CLI rendering remains functional;
- render failure cannot masquerade as success.

## Out of scope

- cloud rendering;
- render queues;
- background jobs after closing the tab;
- server fallback;
- codec selector;
- resolution selector;
- audio;
- batch export.

## Done when

The web app can complete the same conceptual Story → MP4 journey as the CLI, entirely inside a supported browser.
