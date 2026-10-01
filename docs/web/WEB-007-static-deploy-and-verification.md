# WEB-007 — Static deployment and Web MVP verification

> Status: **Proposed**

## Goal

Prove that Tora Video Engine v0.2 can be deployed as a static web application and complete the full authoring → preview → browser render → download flow outside the developer machine.

## Deployment model

The production architecture for v0.2 is:

~~~text
Git repository
     ↓
static build
     ↓
HTML + JS + CSS + bundled/local assets
     ↓
static host
     ↓
user browser
     ↓
editing + preview + WebCodecs render + MP4 download
~~~

No Tora backend is required. This does **not** mean browser rendering is offline, telemetry-free, or automatically free of third-party licensing obligations.

## Remotion license and telemetry prerequisite

Before publishing a production URL, verify the then-current Remotion license terms and record the basis under which the deployment operates.

As of **2026-09-30**, Remotion's published [License & Pricing](https://www.remotion.dev/docs/license/pricing) and [License FAQ](https://www.remotion.dev/docs/license/faq) state that:

- individuals and organizations/teams of up to 3 people are eligible for the Free License, with additional categories such as non-profits/evaluation described upstream;
- organizations not eligible for the Free License require a Company License;
- programmatic `renderMediaOnWeb()` / `renderStillOnWeb()` and use of `<Player>` are classified as automation; video editors are explicitly listed as an Automators use case;
- under the current Company License pricing, Remotion for Automators is **$0.01 per render with a $100/month minimum**; Player previews themselves are not counted as renders.

Therefore static hosting/no Tora backend must never be documented as implying zero software-license cost.

Release requirements:

- re-check the official Remotion license/pricing pages immediately before production deployment because terms and pricing can change;
- record whether the deployment is using verified Free License eligibility or an appropriate Company/Enterprise license;
- configure only the appropriate **public/client-side** license key for web rendering, or `"free-license"` when eligible;
- do not ship a private Remotion license key in browser assets;
- include the mandatory client-render telemetry behavior in privacy/CSP/deployment documentation.

## Initial target

Netlify is the initial deployment target because the application can be served as static output.

The implementation should remain host-neutral enough that the same build artifact can also be served by alternatives such as Cloudflare Pages or another root-path static host.

For v0.2, the supported production deployment model assumes the app is served from the origin root (`/`). Repository-subpath deployments such as the default `/owner/repository/` shape of a GitHub Pages project site are intentionally out of scope because Remotion `staticFile()` asset resolution and the web bundle would require separate base-path handling and verification.

Do not advertise GitHub Pages project-site deployment as supported in v0.2 unless a later change adds and tests subpath-safe bundle and asset resolution.

Do not introduce Netlify Functions merely because Netlify is the first target.

## Build requirements

A clean checkout must support:

~~~bash
npm install
npm run web:build
~~~

The resulting static directory must contain everything required to load the application and its bundled/local assets.

If SPA route fallback configuration is needed, keep it minimal. Prefer a single-page root route if additional routing provides no v0.2 value.

## CI

Extend CI to verify at minimum:

- install;
- existing tests/lint/typecheck;
- existing CLI/reference render path;
- web production build.

Add lightweight browser-level automation if it can remain reliable and inexpensive.

A useful automated smoke flow is:

1. load the production web build;
2. confirm the canonical Story appears;
3. change one visual field;
4. confirm preview state changes;
5. verify invalid YAML is rejected and disables MP4 rendering;
6. discard/revert the invalid YAML and verify rendering becomes eligible again when browser capability allows it;
7. verify render capability/UI state is detectable;
8. verify a Story above 300 seconds / 9,000 frames remains schema-valid but browser render is disabled with the documented limit message;
9. create a dirty YAML buffer and verify switching to visual mode requires Apply, Discard, or Stay rather than enabling parallel visual edits;
10. simulate a localStorage write failure/quota error and verify Apply remains successful in memory while a persistence warning is shown;
11. create an invalid visual draft and verify switching to YAML requires Discard or Stay rather than losing the draft;
12. start a browser render and verify all Story/draft-mutating controls remain locked until completion/failure/cancel;
13. import a schema-valid Story with 201+ scenes and verify it never mounts into the visual editor/Player, remains identified as schema-valid, and receives the browser-limit/CLI guidance;
14. import a schema-valid Story above 9,000 frames and verify the same preview-suppression behavior;
15. perform several consecutive caption edits after Player mount, including rapid overlapping edits, and verify font readiness follows the newest caption without deadlock or stale completion;
16. create a 201st visual scene and verify the candidate remains visible as pending, the previous active Story stays in Player, and MP4 render is disabled until the candidate is reduced/discarded/transferred;
17. load schema-valid but >200-scene or >9,000-frame data from localStorage and verify startup rejects it before Player mount, falls back safely, and shows a browser-policy warning;
18. verify schema-valid but browser-over-budget YAML cannot enable Apply or enter visual mode;
19. Apply YAML with comments/noncanonical spacing/key order and verify it becomes clean immediately; edit one character afterward and verify it becomes dirty;
20. reject an imported YAML file above 1 MiB before reading/parsing it, and reject a >1 MiB pasted buffer before `parseStorySource()`;
21. transfer an over-budget visual candidate to YAML and verify **Export current YAML candidate** downloads that candidate rather than the older active Story;
22. verify the render-time budget check is a defensive recheck of the same authoring policy, not a separate reachable over-budget render path;
23. attempt a visual title update of 65,537 UTF-16 code units and verify it is rejected before `StorySchema.safeParse()` / `serializeStorySource()`; verify 65,536 proceeds to normal policy checks;
24. build a maximum-boundary v0.2 fixture (65,536-code-unit title, 200 schema-valid scenes, captions at their current schema limit while staying ≤9,000 frames) and verify its canonical serialization remains ≤1 MiB; keep the canonical-size policy branch as a defensive invariant rather than requiring an unreachable canonical-only rejection;
25. verify every accepted Active Story exports to canonical YAML ≤1 MiB and that exporting then re-importing that file succeeds through the same source-size guard;
26. transfer a schema-valid visual candidate rejected for a non-source-size browser policy reason, verify its validated-transfer snapshot permits candidate export without reparsing, then edit the buffer and verify that provenance is cleared;
27. apply noncanonical YAML A, leave YAML cleanly, commit visual Story B, then transfer rejected candidate C; verify the YAML baseline is freshly generated from B, not retained from A;
28. invoke Reset with dirty YAML and with a pending visual candidate; verify each requires explicit destructive confirmation and Stay preserves the draft;
29. start from schema-valid persisted data that now fails browser policy; verify it is retained as an exportable recovery snapshot, fallback autosave cannot overwrite it, and only explicit discard/reset acknowledgement releases the protected slot;
30. import/apply YAML under 1 MiB containing a 65,537-code-unit title and verify it passes schema but is rejected by centralized browser policy before timeline derivation/canonical serialization;
31. place the same 65,537-code-unit Story in localStorage and verify restore rejects it through the same title policy before Player mount;
32. make YAML dirty and verify reload/navigation/tab close activates the native `beforeunload` confirmation; Apply/Discard removes it once no other loss-risk state remains;
33. simulate persistence failure after a valid Story becomes active and verify unload protection remains enabled until durable persistence succeeds or the in-memory change is explicitly discarded/reset;
34. restore a policy-rejected stored recovery snapshot, edit the in-memory fallback Story, and verify autosave remains suppressed **but** the edit is marked unpersisted, activates `beforeunload`, and offers active-Story YAML export; release the recovery slot and verify persistence is attempted before the unload guard clears;
35. with dirty YAML, a pending visual draft, and an unpersisted active Story in separate cases, validate an import candidate and verify it cannot commit without explicit **Discard current pending/recovery work and import** confirmation; Cancel import preserves the prior state;
36. try an invalid import while current work is pending and verify the import error does not discard or alter the existing draft;
37. simulate persistence failure after a valid Story becomes active with no dirty YAML/visual draft/recovery snapshot, invoke Reset, and verify Reset still requires explicit destructive confirmation and keeps **Export active Story YAML** available before discard;
38. render fixed frames for canonical centered captions, left-aligned captions, long natural text, and a long unbroken token; verify documented Player/CLI ↔ web-render semantic parity for alignment, line breaks, clipping, and font usage;
39. verify YAML and MP4 filename generation share the same sanitizer across reserved separators/control characters, Windows device names, Unicode/emoji, whitespace-only-after-sanitization, and a 65,536-code-unit title; assert basename ≤96 UTF-8 bytes;
40. verify the deployed render path is documented as emitting Remotion client telemetry, uses only a client-safe/free license-key configuration, and does not depend on telemetry success for render completion;
41. feed a schema-valid 201-scene candidate through visual policy, YAML Apply/import, localStorage restore, and WEB-006's defensive recheck; in every path assert the centralized policy rejects on scene count **without calling timeline derivation or `serializeStorySource()`**;
42. open two same-origin tabs simultaneously and verify exactly one acquires the persistence-writer lock; edits in the secondary tab remain session-only/unpersisted and cannot overwrite the primary tab's durable Story;
43. with the primary tab protecting a rejected stored recovery snapshot, edit/import/reset from the secondary tab and verify no project/recovery `localStorage` key is mutated; after the primary closes, use **Retry persistence ownership**, re-read durable state, and require explicit conflict resolution before any overwrite;
44. verify the shared filename sanitizer rejects/prefixes Win32 Unicode device aliases `COM¹`, `COM²`, `COM³`, `LPT¹`, `LPT²`, and `LPT³`, including aliases followed by extensions;
45. mock/force capability detection to resolve `web-fs` and verify both `canRenderMediaOnWeb()` and `renderMediaOnWeb()` receive `muted: true`, the render call receives `outputTarget: "web-fs"`, and the canonical MP4 has no audio track, exactly 360 video frames, and 12.0-second container duration;
46. mock/force capability detection to return `canRender: true` with `resolvedOutputTarget: "arraybuffer"`; verify Render MP4 remains disabled, `renderMediaOnWeb()` is not called, and editing/preview/YAML export/CLI guidance remain available;
47. open two same-origin tabs with `web-fs` capability and start Render MP4 in tab A; verify tab B cannot enter `renderMediaOnWeb()` until A has completed `getBlob()`, download handoff, and OPFS cleanup/released the dedicated render lock;
48. seed stale `__remotion_render:` OPFS files, then perform 20 sequential successful renders in one long-lived tab plus one cancelled and one failed render; after each lifecycle verify no render-prefixed file accumulation remains and origin storage usage does not monotonically grow from leaked Remotion outputs;
49. inject a delayed OPFS writer close on failure/cancel so the first `removeEntry()` attempt cannot succeed; verify the render lock remains held, cleanup follows the documented retry/backoff schedule, and another tab cannot render until the prefix is observed empty;
50. force cleanup retries to exhaust; verify the UI enters `cleanup-blocked`, authoring may resume but browser render stays disabled, the render Web Lock remains owned, and **Retry cleanup** releases it only after deletion succeeds;
51. start a render, invoke **Cancel Render**, verify state becomes `cancelling`, the owned `AbortController` is aborted exactly once, the render promise is awaited, and cleanup completes (or enters `cleanup-blocked`) before the render lifecycle is considered finished;
52. paste/edit a multi-megabyte YAML string and verify the `nextBuffer.length > 1_048_576` guard rejects it before editor-state commit, `TextEncoder`, YAML parsing, or Zod;
53. paste a multi-megabyte caption into a visual scene and verify the 360-UTF-16-unit raw guard rejects it before `StorySchema.safeParse()`, code-point counting, or font-coverage validation;
54. create the 201st visual scene, then repeatedly invoke Add and verify the visual candidate remains exactly 201 scenes while edit/delete/reorder/transfer remain available; delete back to 200 and verify Add becomes available again.

A full MP4 render in every CI run is optional if browser/WebCodecs constraints make it flaky or expensive; the final release must still include a documented real-browser render verification.

## Manual web release checklist

Test the deployed site in current supported desktop browsers available to the project.

For each tested browser record:

- app loads;
- assets load;
- visual editor works;
- Player controls work;
- YAML import/apply works, and import cannot overwrite pending/unpersisted/recovery state without explicit destructive confirmation;
- invalid, over-budget, or otherwise dirty YAML visibly blocks MP4 rendering until an eligible Apply or discard;
- a successful Apply of noncanonical YAML clears dirty state without requiring canonical text equality;
- dirty YAML cannot be bypassed by switching into editable visual mode without an Apply/Discard/Stay decision, and Reset cannot silently discard dirty, pending, recovery, **or unpersisted active** state;
- an invalid visual draft cannot be bypassed by switching to YAML without a Discard/Stay decision;
- reload restores browser-eligible valid local state when persistence succeeds; schema-valid stored state rejected only by current browser policy remains recoverable/exportable and protected from fallback overwrite;
- storage quota/access failure is handled without crashing or rolling back the active Story, with a visible recovery warning and unload protection while that active Story is not durably stored;
- opening a second same-origin tab never creates a second storage writer: only the persistence-owner tab may mutate project/recovery localStorage keys, and secondary-tab edits are visibly session-only;
- browser `web-fs` renders are separately serialized across tabs; a second tab cannot start Remotion rendering while the dedicated render lock is owned;
- edits made while a rejected recovery snapshot suppresses autosave are also visibly unpersisted and unload-protected;
- browser render capability result including `resolvedOutputTarget`;
- browser MP4 export is offered only for `web-fs`; an `arraybuffer`-only result is explained and does not start rendering;
- if supported, canonical Story renders and downloads successfully with `muted: true`, contains no audio track, and measures exactly 360 video frames / 12.0 seconds;
- centered/left/long/unbroken caption fixtures match the documented shared-layout semantics under the normal web renderer without relying on experimental HTML-in-canvas;
- downloaded YAML and MP4 names remain deterministic, portable, and bounded for hostile/very long titles, including Win32 superscript device aliases;
- while rendering or cancelling, authoring controls cannot mutate the Story or create a new draft;
- Cancel Render is always available during an active render, aborts through the owned `AbortController`, and does not release the render lock before locked OPFS cleanup completes;
- a delayed writer close exercises cleanup retry/backoff; exhausted cleanup enters `cleanup-blocked` and blocks all further browser renders until Retry cleanup succeeds;
- oversized visual title input is rejected before Story construction, and oversized titles from YAML/import/storage are rejected by the centralized post-schema policy before timeline/canonical serialization;
- an over-budget visual candidate remains pending and blocks render rather than allowing export of the previous active Story;
- pasted/edited YAML above 1,048,576 UTF-16 code units is refused before `TextEncoder`; remaining buffers above 1 MiB UTF-8 are refused before synchronous parsing;
- a schema-valid browser-policy-rejected visual candidate can transfer to YAML within the normal 1 MiB source ceiling; unchanged transfer provenance may skip redundant parsing, while editing clears that provenance and returns to normal validation;
- an over-budget Story from YAML/import/storage is refused by browser authoring/preview before Player mount without being reported as schema-invalid;
- YAML Apply is disabled while the parsed Story exceeds browser authoring policy;
- schema-valid over-budget YAML remains exportable as the current YAML candidate for CLI use;
- repeated live caption edits continue rendering with the bundled font and never leave the Player stuck behind a stale render-delay handle;
- Remotion telemetry/privacy/CSP behavior is documented and verified for the deployed origin;
- the production release record states the current Remotion license basis and confirms that no private license key is shipped client-side.

At minimum, complete the golden end-to-end render in one supported browser.

## Golden end-to-end flow

Starting from a clean browser storage state:

1. open deployed app;
2. canonical/default Story loads;
3. inspect all available Tora poses/backgrounds/animations;
4. edit a caption;
5. change a pose;
6. reorder scenes;
7. preview reflects the valid Story;
8. export YAML;
9. reload and verify persistence;
10. render MP4;
11. download and inspect the result.

## Regression requirements

The web release must not regress v0.1:

- \`npm test\`;
- \`npm run lint\`;
- Remotion Studio;
- \`npm run video -- stories/friday-deploy.yaml\`;
- deterministic Story/timeline behavior.

## Documentation

Update the root README when implementation reaches this spec so it documents:

- local CLI workflow;
- web development workflow;
- production web URL;
- static deployment architecture;
- browser rendering requirements/limitations, including mandatory Remotion client-render telemetry, the required `web-fs` output target, and the lack of an `arraybuffer` fallback in v0.2;
- current Remotion licensing prerequisite and where the deployment's license basis is recorded;
- link to \`docs/web/\` as the v0.2 source of truth.

## v0.2 completion checklist

- [ ] WEB-001 accepted
- [ ] WEB-002 accepted
- [ ] WEB-003 accepted
- [ ] WEB-004 accepted
- [ ] WEB-005 accepted
- [ ] WEB-006 accepted
- [ ] production static build succeeds
- [ ] deployed site loads without application backend
- [ ] visual editor flow passes
- [ ] visual title >65,536 UTF-16 code units and visual caption >360 UTF-16 code units are rejected before Story validation
- [ ] YAML/import/restore title >65,536 is rejected by centralized post-schema policy before timeline/serialization
- [ ] browser authoring/preview policy short-circuits in the order title → scene count → frames → canonical bytes
- [ ] 201+ scene candidates never invoke timeline derivation or canonical serialization in visual/YAML/import/restore/render-recheck paths
- [ ] visual Add cannot grow an over-budget pending draft beyond 201 scenes
- [ ] browser authoring/preview budget blocks >200 scenes or >9,000 frames before Player mount, with a final defensive canonical-YAML ≤1 MiB invariant
- [ ] maximum-boundary v0.2 fixture remains ≤1 MiB canonical YAML, so no unreachable canonical-only rejection test is required
- [ ] every Active Story canonical YAML export stays ≤1 MiB and successfully re-imports
- [ ] policy-rejected visual candidates remain pending and disable stale render/export
- [ ] persisted Stories are rechecked against browser policy before restore
- [ ] policy-rejected stored Stories remain exportable and protected from fallback overwrite until explicit discard
- [ ] YAML Apply requires both schema validity and browser eligibility
- [ ] successful Apply resets YAML dirty baseline even for noncanonical source
- [ ] pasted/edited YAML >1,048,576 UTF-16 code units is rejected before `TextEncoder`, then exact >1 MiB UTF-8 is rejected before parse
- [ ] transferred visual candidates remain within the 1 MiB source ceiling under current v0.2 structural bounds
- [ ] editing a transferred buffer clears validated-transfer provenance and requires normal validation again
- [ ] policy-rejected YAML candidate can be exported verbatim for CLI use
- [ ] live caption-font reload is safe across sequential and overlapping Story updates
- [ ] asset catalog flow passes
- [ ] YAML import/export flow passes
- [ ] persistence flow passes, including quota/access failure handling and suppressed-write loss-risk while recovery storage is protected
- [ ] cross-tab persistence has exactly one Web Locks writer and secondary tabs cannot overwrite active/recovery storage
- [ ] persistence ownership retry re-reads durable state and requires explicit conflict resolution before overwrite
- [ ] YAML/visual mode-switch conflict guards pass in both directions
- [ ] YAML baseline is regenerated from current Active Story on candidate transfer
- [ ] Reset requires explicit destructive confirmation whenever any loss-risk/recovery state exists, including an active Story that differs from durable storage
- [ ] beforeunload protects dirty YAML, pending visual drafts, transfer candidates, and active Stories not durably stored because persistence failed or was intentionally suppressed
- [ ] unload guard is removed promptly when no loss-risk state remains
- [ ] import commit is gated by explicit destructive confirmation whenever pending/unpersisted/recovery state exists
- [ ] invalid/cancelled imports preserve existing pending work
- [ ] normal web-renderer compatibility pass covers all render-critical shared components
- [ ] centered/left/long/unbroken caption golden parity passes without depending on experimental HTML-in-canvas
- [ ] shared YAML/MP4 download basename sanitizer passes reserved-character, Unicode/emoji, ASCII and superscript Win32 device-name, empty-result, and 65,536-code-unit boundary tests
- [ ] Remotion client-render telemetry is disclosed in deployment/privacy/CSP docs
- [ ] production release records current Remotion license basis and uses only a client-safe/free license-key configuration
- [ ] capability and render calls both use `muted: true`
- [ ] full browser MP4 render requires `resolvedOutputTarget === "web-fs"`; `arraybuffer` fallback is rejected without starting render
- [ ] dedicated render Web Lock serializes `web-fs` rendering across same-origin tabs through Blob/download handoff and positively-completed cleanup
- [ ] Cancel Render is mandatory, uses `AbortController`, awaits render settlement, and shares the locked cleanup path
- [ ] delayed writer-close test proves cleanup retries/backoff while retaining the render lock
- [ ] exhausted cleanup enters `cleanup-blocked`; Retry cleanup is required before the lock/render capability is released
- [ ] repeated success/failure/cancel render lifecycles clean `__remotion_render:` OPFS files and do not accumulate origin storage
- [ ] canonical browser MP4 has no audio track and is exactly 360 video frames / 12.0 seconds
- [ ] canonical browser MP4 render passes on a supported browser
- [ ] in-flight render authoring lock prevents stale-result downloads
- [ ] render start defensively rechecks the same centralized title / 200-scene / 9,000-frame / 1-MiB-canonical-YAML authoring policy
- [ ] existing CLI render still passes
- [ ] README matches the implemented workflows

## Out of scope

- paid hosting optimization;
- custom backend;
- authentication;
- cloud persistence;
- cloud render;
- CDN/media pipeline beyond static hosting needs;
- production analytics;
- multi-user reliability/SLA;
- non-root/subpath hosting such as default GitHub Pages project sites.

## Done when

A user can visit the deployed static application and complete Tora's full v0.2 flow from Story authoring to a downloaded MP4, while the existing CLI remains intact.
