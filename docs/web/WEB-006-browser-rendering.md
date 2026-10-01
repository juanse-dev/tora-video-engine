# WEB-006 — Browser-side MP4 rendering

> Status: **Proposed**

## Goal

Render the current validated Story to an H.264 MP4 entirely in the user's browser and make the result downloadable.

## User-visible outcome

The user clicks **Renderizar MP4**, sees render state/progress, and receives a downloadable vertical MP4 without a Tora application backend.

## Technology boundary

Use \`@remotion/web-renderer\` at the same exact Remotion version as the repository.

The renderer must consume the shared composition. Reuse of the same React component tree does **not** by itself prove compatibility with the client-side renderer:

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

Do not render screenshots from the visible Player or maintain a parallel Tora canvas renderer.

## Mandatory web-renderer compatibility pass

Remotion client-side rendering's default path emulates DOM layout/styles into a canvas and supports only the elements and CSS styles documented by the pinned web renderer. See the upstream [client-side rendering limitations](https://www.remotion.dev/docs/client-side-rendering/limitations).

The current shared `src/components/Caption.tsx` relies on `textAlign`, `overflowWrap`, and `wordBreak` for caption semantics. Those properties are not in the documented supported text-style set, so v0.2 must not assume that Player/CLI layout will automatically survive `renderMediaOnWeb()`.

For v0.2, keep the normal supported client-renderer path and **adapt the shared caption implementation** so Player, CLI, and browser render still share one component while alignment/wrapping is expressed through supported primitives or explicit deterministic line layout.

Requirements:

- audit `ToraVideo` and every render-critical descendant against the pinned `@remotion/web-renderer` supported elements/styles before enabling MP4 export;
- remove or stop relying on unsupported CSS for semantic behavior such as horizontal alignment, line wrapping, clipping, or scene layering;
- preserve the existing visible intent for both `left` and `center` captions;
- make long natural-language text and long unbroken tokens wrap deterministically without relying on unsupported `overflowWrap` / `wordBreak` behavior;
- keep the compatibility refactor shared so CLI/Studio/Player do not receive a separate web-only caption renderer;
- add regression coverage that fails if Player/CLI and web-render paths disagree on caption layout.

Do **not** make Remotion's optional HTML-in-canvas capture mode a v0.2 requirement or parity escape hatch. The upstream [HTML-in-canvas documentation](https://www.remotion.dev/docs/client-side-rendering/html-in-canvas) describes it as experimental, Chromium-specific, dependent on browser feature support, and able to fall back to the normal DOM composer. A future opt-in path may use it only behind explicit capability detection and separate verification.

Browser MP4 export is not implementation-complete until this compatibility pass succeeds.

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

- maximum Story title: **65,536 UTF-16 code units for every candidate source**; the visual editor additionally performs an early raw-input guard before construction;
- maximum active scenes: **200**;
- maximum total duration: **300 seconds**;
- equivalent maximum at fixed 30 FPS: **9,000 frames**;
- maximum canonical YAML size: **1 MiB UTF-8**.

WEB-006 does **not** introduce a higher or independent export threshold in v0.2. Instead, render eligibility defensively rechecks the same centralized policy immediately before starting the web renderer.

Therefore:

- raw visual title above 65,536 code units is rejected before construction, while YAML/import/restore candidates with the same oversized title are rejected by the centralized post-schema policy before timeline/serialization; a candidate above 200 scenes, 9,000 frames, or 1 MiB canonical YAML is likewise rejected before it becomes active;
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
- name the file `${getDownloadBasename(renderSnapshot.title)}.mp4`, reusing the exact shared sanitizer specified by WEB-005;
- trigger the browser download;
- revoke temporary URLs when they are no longer needed.

A failed render must not present an old Blob as the new successful result.

## Compatibility verification

The canonical Story is one golden web-render test, but it is not sufficient by itself.

Verify that browser output has:

- H.264 MP4;
- 1080 × 1920 dimensions;
- 30 FPS where metadata inspection makes this available;
- 12-second duration / 360 frames for the canonical fixture;
- expected scene order, assets, captions, and animations.

Add dedicated caption golden fixtures for:

- the canonical centered caption;
- a left-aligned caption;
- long natural-language text near the schema caption limit;
- a long unbroken token that exercises deterministic wrapping.

For fixed representative frames, compare the client-render result against the shared Player/CLI intent with a documented visual tolerance and explicit assertions for caption box position, horizontal alignment, line breaks/line count, clipping, and font usage. Anti-aliasing/codec pixels need not be byte-identical.

The CLI and browser render do not need byte-identical MP4 files. They must be semantically equivalent outputs from the same Story/render plan.

## Mandatory Remotion client-render telemetry

Client-side Remotion rendering is **not telemetry-optional**. Under the current upstream [Telemetry documentation](https://www.remotion.dev/docs/telemetry) and [License FAQ](https://www.remotion.dev/docs/license/faq), client-side telemetry cannot be disabled: each `renderMediaOnWeb()` / `renderStillOnWeb()` attempt sends a Remotion telemetry event even when no license key is configured; successful and failed renders emit events, while aborted renders do not.

The implementation and deployment documentation must therefore:

- not describe browser rendering as fully offline or zero-network;
- disclose that the end user's IP address and page origin/domain are sent to Remotion for licensing/accountability telemetry, together with render type, environment, success/failure, and a license key when configured;
- note that video content, video metadata, and Tora user content are not sent by this telemetry according to the upstream documentation;
- ensure privacy/CSP/deployment review accounts for this outbound telemetry request;
- note that telemetry-request failure does not fail the video render;
- use only a client-safe/public Remotion license key in browser code, or `"free-license"` when current Free License eligibility has been verified; never embed a private server-side license key.

If organization policy forbids the required telemetry path, production deployment must resolve the reporting/licensing requirement with Remotion rather than silently claiming telemetry is disabled.

## Acceptance criteria

- supported browsers can render the canonical Story to an H.264 MP4;
- a web-renderer compatibility audit covers all render-critical shared components, and no unsupported CSS property is relied on for caption alignment/wrapping semantics;
- centered, left-aligned, long wrapped, and long unbroken caption golden cases demonstrate semantic Player/CLI ↔ browser-render parity;
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
- final MP4 filename reuses WEB-005 `getDownloadBasename()` and is deterministic/bounded for arbitrary valid titles;
- output timing/dimensions match the engine configuration;
- local CLI rendering remains functional;
- render failure cannot masquerade as success;
- client-render telemetry is documented as mandatory upstream behavior and deployment/privacy/CSP documentation reflects it.

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
