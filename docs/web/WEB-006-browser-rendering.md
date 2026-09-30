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

## Render eligibility

The primary render action must only be enabled when all of the following are true:

- the current browser supports the requested H.264/MP4 render configuration;
- the visual editor has no invalid draft values;
- the YAML editor has no unapplied buffer changes;
- a validated Story is available.

If the visible editor state is invalid or unapplied, do not offer to render the previous validated Story behind it. Disable the action and explain what must be fixed, applied, or discarded first.

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
- do not allow editor changes to replace the validated Story snapshot being rendered.

The render should capture one immutable Story snapshot at start so edits made during rendering cannot mutate the in-flight output.

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
- MP4 rendering is disabled whenever visual draft state is invalid or YAML contains unapplied changes, preventing accidental export of a stale validated Story;
- unsupported browsers receive a useful message and can still edit/preview;
- render uses an immutable validated Story snapshot;
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
