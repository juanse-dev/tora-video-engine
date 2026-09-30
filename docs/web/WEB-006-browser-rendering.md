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

WEB-003/WEB-005 already enforce the browser authoring/preview ceiling before a Story can become active:

- maximum visual title: **65,536 UTF-16 code units**, checked before candidate construction/serialization;
- maximum active scenes: **200**;
- maximum total duration: **300 seconds**;
- equivalent maximum at fixed 30 FPS: **9,000 frames**;
- maximum canonical YAML size: **1 MiB UTF-8**.

WEB-006 does **not** introduce a higher or independent export threshold in v0.2. Instead, render eligibility defensively rechecks the same centralized policy immediately before starting the web renderer.

Therefore:

- raw visual title above 65,536 code units is rejected before serialization, and a candidate above 200 scenes, 9,000 frames, or 1 MiB canonical YAML is rejected by authoring policy before it becomes active;
- it cannot reach browser render eligibility as an active Story;
- the render-time check protects against state corruption, policy drift, or implementation bugs;
- CLI portability remains available through YAML export for schema-valid candidates.

Do not describe an over-budget Story as being rejected *only* by render eligibility.

## Render eligibility

The primary render action must only be enabled when all of the following are true:

- the current browser supports the requested H.264/MP4 render configuration;
- the visual editor has no pending candidate that differs from the active Story, whether schema-invalid or browser-policy-ineligible;
- the YAML editor has no unapplied buffer changes;
- an active validated Story that has already passed the browser authoring/preview budget is available;
- the Story's derived total duration/frame count is within the v0.2 browser render budget.

If either editor has pending content that is not the active Story—schema-invalid visual input, browser-policy-rejected visual input, or unapplied YAML—do not offer to render the older active Story behind it. Disable the action and explain what must be fixed, reduced into budget, transferred, applied, or discarded first.

If the defensive render-time policy check somehow finds that the active Story exceeds the browser budget, abort before rendering, report an internal/policy mismatch, and keep the CLI/YAML alternative available. Under the required authoring gate, this state should not arise during normal use.

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
- an active Story whose title is within the visual bound and that is at or below 200 scenes, 300 seconds / 9,000 frames, and 1 MiB canonical YAML remains render-eligible when all other requirements pass;
- schema-valid candidates above the browser budget are rejected by authoring policy before activation and cannot reach normal browser rendering;
- render start defensively rechecks the same centralized authoring policy and aborts on any mismatch;
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
