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

Before enabling the render action, call the pinned version's `canRenderMediaOnWeb()` with the same video-only media settings that will be used for the real render, including **`muted: true`**, H.264/MP4, and the engine dimensions.

Consume both `canRender` and `resolvedOutputTarget`.

For v0.2, browser MP4 export is supported only when:

- `canRender === true`; and
- `resolvedOutputTarget === "web-fs"`.

The pinned renderer may otherwise resolve to `"arraybuffer"`, which uses an in-memory `BufferTarget` and retains the complete encoded MP4 **during the entire render**. v0.2 deliberately does not use that fallback. The separate post-render materialization cap defined below is not equivalent: rendering still streams to OPFS first, and only the finalized output is copied into bounded memory after its exact encoded size is known.

If capability fails or resolves only to `arraybuffer`:

- do not start the render;
- explain whether codec/WebCodecs support or the safe `web-fs` output target is unavailable;
- keep editing and preview usable;
- mention YAML export and the existing local CLI as alternatives.

Do not add a server fallback in this spec. A custom `outputWritable` streaming path may be evaluated in a future version but is out of scope for v0.2.

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
- **video-only / no audio track**;
- 1080 × 1920;
- 30 FPS.

Both capability detection and the actual render must explicitly pass `muted: true`. Do not rely on the pinned renderer's default, which is `false`.

When starting `renderMediaOnWeb()`, also pass `outputTarget: "web-fs"` after capability detection has confirmed that `resolvedOutputTarget` is `"web-fs"`. The capability result and render call must therefore agree on the media/output assumptions used for eligibility.

Any other web-renderer API options required for the installed Remotion version should be implemented according to that exact version.

## Browser render budget

WEB-003/WEB-005 already enforce the browser authoring/preview ceiling before a Story can become active:

- maximum Story title: **65,536 UTF-16 code units for every candidate source**; the visual editor additionally performs an early raw-input guard before construction;
- maximum active scenes: **200**;
- maximum total duration: **300 seconds**;
- equivalent maximum at fixed 30 FPS: **9,000 frames**;
- maximum canonical YAML size: **1 MiB UTF-8**.

WEB-006 does **not** introduce a higher or independent **Story** threshold in v0.2. Instead, render eligibility defensively calls the exact same ordered `evaluateBrowserStoryPolicy(story)` from WEB-003 immediately before starting the web renderer, then separately requires the safe `web-fs` output target.

Therefore:

- the defensive recheck preserves the same short-circuit order **title → scene count → derived frames → canonical serialization/bytes**;
- a title or 201+ scene failure returns before timeline derivation; title/scene/frame failures return before canonical serialization;
- candidates over any browser limit cannot reach normal browser render eligibility as active Stories;
- the render-time check protects against state corruption, policy drift, or implementation bugs without duplicating/reordering policy logic;
- CLI portability remains available through YAML export for schema-valid candidates.

Do not describe an over-budget Story as being rejected *only* by render eligibility.

## Render eligibility

The primary render action must only be enabled when all of the following are true:

- `canRenderMediaOnWeb({... muted: true, ...})` reports the requested H.264/MP4 configuration as renderable;
- that same capability result has `resolvedOutputTarget === "web-fs"`;
- the dedicated same-origin render Web Lock API is available and no other tab currently owns the render lock;
- the visual editor has no pending candidate that differs from the active Story, whether schema-invalid or browser-policy-ineligible;
- the YAML editor has no unapplied buffer changes;
- an active validated Story that has already passed the browser authoring/preview budget is available;
- the Story's derived total duration/frame count is within the v0.2 browser render budget.

If either editor has pending content that is not the active Story—schema-invalid visual input, browser-policy-rejected visual input, or unapplied YAML—do not offer to render the older active Story behind it. Disable the action and explain what must be fixed, reduced into budget, transferred, applied, or discarded first.

If the defensive render-time policy check somehow finds that the active Story exceeds the browser budget, abort before rendering, report an internal/policy mismatch, and keep the CLI/YAML alternative available. Under the required authoring gate, this state should not arise during normal use.

## Cross-tab render exclusivity and OPFS lifecycle

The pinned Remotion renderer serializes media renders only inside one JavaScript realm. That module-local queue does not protect two same-origin tabs, while the required `web-fs` path uses shared origin-private file-system storage and performs stale-file cleanup at render start.

v0.2 must therefore acquire a second, dedicated exclusive Web Lock before invoking `renderMediaOnWeb()`:

~~~ts
tora-video-engine:web-fs-render
~~~

This lock is independent from the WEB-005 persistence-writer lock and is intentionally **unversioned**.

The lock protects Remotion's unversioned, same-origin OPFS namespace `__remotion_render:`, not a v0.2 data schema. Therefore every current and future Tora bundle that uses that shared prefix must acquire this exact same lock name. Do not append a release/schema version while the protected Remotion namespace remains global. An old tab left open across a deploy and a newly loaded tab must still mutually exclude each other. If a future renderer moves to a different isolated OPFS namespace, changing the lock name requires an explicit migration/design decision.

Required behavior:

- acquire the render lock **immediately before any OPFS cleanup / `renderMediaOnWeb()` call**;
- if the lock is unavailable, do not start a second render. Show that another Tora tab is rendering and offer Retry/Cancel rather than relying on Remotion's module-local queue;
- if `navigator.locks` is unavailable, disable v0.2 browser MP4 rendering because cross-tab safety for the required `web-fs` lifecycle cannot be guaranteed; preview/edit/YAML/CLI remain usable;
- hold the lock across `renderMediaOnWeb()`, `getBlob()`, final-output materialization, and Tora's OPFS cleanup;
- release it only after the independent downloadable Blob exists (success path) and the render's temporary OPFS state is cleaned, including failure/cancel/materialization-failure paths.

### Tora-owned Remotion OPFS cleanup

The pinned `web-fs` implementation creates files named `__remotion_render:<session>:<uuid>` and does not delete completed files from the current session. Tora must not rely solely on Remotion's stale-session cleanup.

While holding the render lock, Tora owns cleanup of this prefix for its origin:

1. obtain the OPFS root via `navigator.storage.getDirectory()`;
2. **before every render starts, call the same awaitable `cleanupRemotionOpfsUntilEmpty()` helper defined below and do not call `renderMediaOnWeb()` until it has positively observed an empty `__remotion_render:` prefix**;
3. run the web render and call `getBlob()`; treat the returned object as potentially OPFS-backed and **not yet safe to outlive the render file**;
4. validate/materialize the finalized output through the independent-download protocol below;
5. only after independent materialization succeeds, call `cleanupRemotionOpfsUntilEmpty()` to delete the Remotion OPFS file(s);
6. release the render lock after cleanup has positively observed an empty prefix;
7. create the object URL and trigger the browser download from the **independent materialized Blob**, which may safely outlive OPFS cleanup and lock release.

On render failure, cancellation, or materialization failure, there is no downloadable success Blob; run the same locked OPFS cleanup protocol and only then release the lock.

### Independent final-output materialization

In Remotion 4.0.529, the `web-fs` target obtains its result from `FileSystemFileHandle.getFile()`. A File System API `File` can become unreadable if its backing entry is changed or removed after `getFile()`. Therefore an object URL plus `<a download>.click()` is **not** an awaitable consumption boundary and must never be used as permission to delete the OPFS entry.

Define:

~~~ts
MAX_BROWSER_DOWNLOAD_MATERIALIZATION_BYTES = 256 * 1024 * 1024
~~~

The value is a browser-output/RAM safety policy, not a StorySchema or authoring limit.

Success path while the render Web Lock is still held:

1. call the renderer's `getBlob()`;
2. inspect `renderedBlob.size` **before** requesting an ArrayBuffer;
3. if size exceeds 256 MiB, do not materialize or trigger a download. Surface **“Browser output too large for safe download”**, offer YAML/CLI rendering, clean the OPFS render files under the lock, and finish as a browser-export failure;
4. if within the cap, execute `const bytes = await renderedBlob.arrayBuffer()`;
5. construct a fresh independent `Blob` from those bytes using the expected MP4 MIME type;
6. only after that copy succeeds may Tora delete `__remotion_render:` OPFS entries;
7. after cleanup/release, create the object URL and download from the independent Blob.

Do not replace the ArrayBuffer copy with `new Blob([renderedBlob])`, `URL.createObjectURL(renderedBlob)`, a timeout after `click()`, or any other operation that does not establish independent backing.

The 256 MiB cap intentionally bounds the one-time finalized-output copy on supported desktop browsers. It does **not** enable the Remotion `arraybuffer` output target, because that target holds the encoded media in memory throughout rendering rather than only after a finalized OPFS-backed result exists.

### Awaitable cleanup before and after render

Do **not** assume that acquiring the render Web Lock means all writers from a previous browser realm are already closed. A previous `cleanup-blocked` page can unload, implicitly releasing the Web Lock while Remotion/Mediabunny's asynchronous writer shutdown is still finishing. Likewise, rejection of the current `renderMediaOnWeb()` does not guarantee its writer is already closed.

Define one helper such as `cleanupRemotionOpfsUntilEmpty()` and use it for **both pre-render preflight and post-render cleanup** while the render Web Lock remains held:

1. enumerate/remove every `__remotion_render:` entry;
2. re-enumerate and succeed only when none remain;
3. when removal fails or entries remain, wait with bounded exponential backoff and retry. Use a documented schedule such as **0, 25, 50, 100, 200, 400, 800, 1,600, 3,200 ms**;
4. if **pre-render** cleanup succeeds during that bounded phase, proceed to `renderMediaOnWeb()` while still holding the lock; if **post-render** cleanup succeeds, complete the render/cancel/failure lifecycle and release the lock;
5. if either bounded phase is exhausted, transition to `cleanup-blocked`, surface that browser render storage is still being released, and **keep the render Web Lock held**. A pre-render exhaustion means `renderMediaOnWeb()` must not be called at all;
6. provide **Retry cleanup**. Each retry reruns the bounded helper under the already-held lock. If a **pre-render** retry succeeds, **release the render Web Lock immediately**, clear the blocked state, and return to idle/render-ready **without starting or retaining the old render request**. The user's next Render click must reacquire the lock and rerun preflight from the beginning. If a **post-render** retry succeeds, clear the warning and release the lock as the final step of the already-completed render lifecycle;
7. page unload may implicitly release the Web Lock, but the next session/new tab must reacquire the same unversioned lock and run this **same retry/backoff preflight helper** before rendering. It must never use a one-shot stale-file deletion. No idle/render-ready tab may retain the render lock merely while waiting for user input.

A successfully **materialized independent** MP4 Blob may be retained for download while post-render cleanup finishes. The original OPFS-backed Blob/File must not be handed to a download flow that outlives cleanup. Cleanup failure must never be treated as permission to release the render lock and “retry on the next render”.

Tests must inject/delay target closure so the first removal attempt fails and prove that both post-render and **new-session pre-render** cleanup wait/retry rather than passing only on fast local writer shutdown.

This prefix cleanup is safe only because the dedicated same-origin render lock makes Tora's `web-fs` render lifecycle exclusive. Do not perform broad OPFS deletion outside that lock.

## Render UI state

At minimum expose:

- idle;
- rendering;
- **cancelling**;
- success;
- failure;
- **cleanup-blocked**.

While rendering:

- create and own one `AbortController` for the render and pass its `signal` to `renderMediaOnWeb()`;
- expose an explicit **Cancel Render** action;
- prevent accidental duplicate concurrent renders from the primary button;
- surface available progress information from the renderer;
- keep an understandable status if progress is coarse;
- lock every control that can change either the validated Story or an editor draft, including visual fields, asset selection, scene add/delete/reorder, YAML editing/apply/import, reset, and editor-mode transitions;
- allow non-mutating interactions such as preview playback if they do not affect the render input.

When the user selects Cancel Render:

1. transition to `cancelling`;
2. disable repeated Cancel requests;
3. call `abortController.abort()`;
4. await the `renderMediaOnWeb()` promise to settle/reject;
5. run the failure/cancel OPFS cleanup protocol below while still holding the cross-tab render lock;
6. only then transition out of the in-flight lifecycle.

Cancellation is a **required v0.2 feature**, not conditional. Authoring remains locked while rendering/cancelling and through the initial cleanup attempt. If cleanup ultimately enters `cleanup-blocked`, authoring may unlock, but Render MP4 remains disabled and the cross-tab render lock remains held until cleanup succeeds or the page is unloaded.

The render must capture one immutable Story snapshot at start. The UI lock ensures that the visible authoring state remains the same snapshot for the lifetime of the render, so a successful download cannot silently represent an older Story than the editor currently shows.

Do not auto-download an output after authoring state has somehow diverged from the render snapshot. This should be unreachable under the required lock; treat any such divergence as a safety assertion/failure rather than presenting the Blob as current.

## Download

When rendering succeeds:

- obtain and independently materialize the finalized MP4 under the 256 MiB protocol above;
- clean OPFS and release the global render lock;
- create a temporary object URL **only from the independent Blob**;
- name the file `${getDownloadBasename(renderSnapshot.title)}.mp4`, reusing the exact shared sanitizer specified by WEB-005;
- trigger the browser download;
- revoke temporary URLs when they are no longer needed.

A timer after `a.click()` is not a correctness boundary. OPFS cleanup must be safe **before** download handoff because the downloadable Blob no longer depends on OPFS.

A failed render or output-too-large/materialization failure must not present an old Blob as the new successful result.

## Compatibility verification

The canonical Story is one golden web-render test, but it is not sufficient by itself.

Verify that browser output has:

- H.264 MP4;
- **no audio track**;
- 1080 × 1920 dimensions;
- 30 FPS where metadata inspection makes this available;
- exactly 360 video frames and 12.0-second duration for the canonical fixture;
- expected scene order, assets, captions, and animations.

The no-audio assertion is required for v0.2. The pinned renderer defaults `muted` to `false`; Remotion issue #7099 documents silent AAC output and encoder priming extending MP4 container duration even for compositions with no audio assets. Explicit `muted: true` avoids creating that silent audio track and keeps the golden duration aligned with the video timeline.

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
- capability is checked before rendering using `muted: true`, and browser MP4 export is enabled only for `resolvedOutputTarget === "web-fs"`;
- MP4 rendering is disabled whenever the visual editor has any pending candidate not reflected by the active Story (schema-invalid or browser-policy-ineligible) or YAML contains unapplied changes, preventing accidental export of a stale active Story;
- an active Story whose title is within the visual bound and that is at or below 200 scenes, 300 seconds / 9,000 frames, and 1 MiB canonical YAML remains render-eligible when all other requirements pass;
- schema-valid candidates above the browser budget are rejected by authoring policy before activation and cannot reach normal browser rendering;
- render start defensively calls the same ordered centralized authoring policy and aborts on any mismatch; a 201+ scene active Story assertion path must not derive timeline metadata or serialize canonical YAML;
- browsers that cannot render H.264/MP4, resolve only to `arraybuffer`, lack Web Locks, or encounter another-tab render ownership receive a useful message and can still edit/preview/export YAML;
- render uses an immutable validated Story snapshot;
- all Story/draft-mutating authoring controls remain locked from render start through success/failure/cancel;
- a completed render cannot auto-download as the current result if authoring state diverged from its snapshot;
- final MP4 filename reuses WEB-005 `getDownloadBasename()` and is deterministic/bounded for arbitrary valid titles;
- output timing/dimensions match the engine configuration, the canonical render is exactly 360 video frames / 12.0 seconds, and the MP4 contains no audio track;
- same-origin browser renders are mutually exclusive across tabs **and concurrently open Tora bundle versions** from awaitable pre-render OPFS cleanup through render, independent output materialization, and positively-completed final cleanup; the actual browser download may occur after lock release because it uses independent backing;
- Cancel Render is implemented with `AbortController`, waits for the render promise to settle, and performs the same locked cleanup path as failures;
- delayed asynchronous writer shutdown cannot cause the render lock to be released early: cleanup retries/backoff until empty or enters `cleanup-blocked` while retaining the lock;
- repeated success/failure/cancel/materialization-failure cycles leave no unbounded `__remotion_render:` OPFS accumulation in a long-lived tab;
- successful downloads remain byte-readable after OPFS cleanup because they use the independently materialized Blob;
- finalized outputs above 256 MiB fail browser download safely before ArrayBuffer allocation and direct the user to the CLI path;
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
- `arraybuffer` browser render fallback;
- custom `outputWritable` streaming;
- batch export.

## Done when

The web app can complete the same conceptual Story → MP4 journey as the CLI, entirely inside a supported browser.
