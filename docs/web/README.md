# Web authoring roadmap

This directory is the implementation plan for **Tora Video Engine v0.2 — Web Authoring MVP**.

v0.1 proved the deterministic renderer:

~~~text
story.yaml → validated Story → Remotion timeline → MP4
~~~

v0.2 adds a browser authoring surface without replacing that contract:

~~~text
assets + visual/YAML authoring
              ↓
      validated Story
              ↓
       live Remotion preview
              ↓
     browser-side H.264 MP4
~~~

The existing local CLI remains a first-class path for automation and CI.

## Product promise

A user can open Tora Video Engine in a browser, see the assets that are available, assemble a story visually, preview it immediately, optionally edit/import YAML, and download an MP4 without installing a local rendering stack.

The first web version is intentionally single-user, local-first, and backend-free.

## Architecture invariants

1. **Validated Story remains the rendering boundary.** The web UI must not create a second rendering model.
2. **One renderer, multiple entry points.** Preview, browser export, Remotion Studio, and the local CLI reuse the same Story, timeline logic, scene components, assets, and video configuration.
3. **The CLI must keep working.** Web work must not regress \`npm run video -- stories/friday-deploy.yaml\`.
4. **Transient editor state is not render state.** UI controls and YAML text may be temporarily invalid or browser-policy-ineligible, but only an active validated `Story` that passed both schema and browser authoring policy can reach preview/persistence/rendering. Any visual candidate that differs from the active Story because it failed schema or browser policy is a pending visual draft and disables MP4 export. Editor mode switches must never silently discard or fork pending drafts.
5. **Assets remain deterministic.** v0.2 uses the repository's bundled Tora poses and backgrounds; no network-generated media is required.
6. **Static hosting only.** The MVP must not require application servers, serverless functions, databases, authentication, or cloud rendering.
7. **No speculative editor platform.** Build the smallest visual authoring experience for the current Story schema.
8. **Browser authoring and rendering are resource-bounded and round-trippable.** A Story may be valid for the shared engine/CLI while still being too large to parse, mount, render, or re-import safely in the browser. v0.2 applies browser-only guards: visual title input is cheaply capped at **65,536 UTF-16 code units before Story construction**, raw visual caption input is capped at **360 UTF-16 code units before Story validation**, the visual scene draft may grow to at most **201 scenes** so the first over-budget state remains editable but cannot grow without bound, incoming untrusted YAML source must be at most 1 MiB UTF-8 before parsing, and **every schema-valid candidate from every source** must then pass the centralized policy `title.length <= 65_536`, ≤200 scenes, ≤300 seconds / 9,000 frames, followed by a defensive canonical-YAML ≤1 MiB invariant before becoming active. Under the current title/scene/caption bounds, canonical >1 MiB is not an independently reachable v0.2 authoring case; keep the final size check to protect round-trip safety against future schema/serializer changes rather than inventing unreachable UX branches/tests.
9. **Production static hosting is root-path based.** v0.2 targets hosts such as Netlify and Cloudflare Pages where the app can be served from the origin root. Repository-subpath deployments such as a default GitHub Pages project site are outside the supported deployment target unless separately verified.
10. **Local persistence is best-effort, recovery-safe, single-writer, and startup-bounded.** A valid Story must remain usable in memory even if browser storage is unavailable or full. Exactly one same-origin tab/bundle version may own writes to the shared project/recovery `localStorage` slots via the **unversioned** lock `tora-video-engine:persistence-writer`; the lock name must remain stable while those physical slots are shared. Startup bounds the raw persisted envelope before `JSON.parse` and applies cheap title/scene/caption preflight before StorySchema so legacy/dev-modified storage cannot force unbounded synchronous validation. Secondary tabs are session-only writers: they may edit/export but cannot autosave or overwrite protected recovery state.
11. **A browser render freezes authoring, is cancellable, and is cross-tab/cross-version exclusive.** From render start until success/failure/cancel settlement, Story-changing and draft-changing controls are read-only. v0.2 owns an `AbortController` and exposes explicit Cancel Render. Because all Tora releases using Remotion `web-fs` share the same same-origin `__remotion_render:` OPFS namespace, browser MP4 renders must use one **unversioned** render Web Lock name that remains stable across deployments. The lock is held through render, bounded independent-output materialization, and awaitable OPFS cleanup. Failure/cancel/materialization cleanup retries while the lock is still held; if cleanup cannot complete, the tab enters a render-cleanup-blocked state and does not release the lock programmatically or permit another render.
12. **Loss-risk state has one destructive-transition policy.** While dirty YAML, a pending visual draft, validated transfer state, or an active Story that differs from durable storage for **any** reason would be lost, treat it as loss-risk state. “Not durably persisted” includes both failed writes and writes intentionally suppressed to protect a rejected stored recovery snapshot. The same predicate must protect unload, Reset, and import commit: none may silently discard loss-risk state.
13. **Web-render parity is proven, not assumed.** The Player/CLI composition remains shared, but browser MP4 export may only ship after every render-critical component uses primitives supported by the pinned `@remotion/web-renderer` path or has explicit equivalent coverage. Unsupported CSS must not silently define caption alignment/wrapping semantics.
14. **Static/local-first does not mean zero-network or license-free.** Client-side Remotion rendering has mandatory upstream telemetry behavior and Remotion licensing requirements that must be documented and verified before production deployment.

## System architecture

~~~mermaid
flowchart LR
    U[User] --> UI[Web UI]

    H[Static hosting<br/>Netlify / Cloudflare Pages] --> UI
    H --> A[Static asset catalog]

    subgraph Browser
      UI --> G[Cheap visual input guard]
      G --> D[Editor draft]
      D --> V[Zod validation]
      V -->|schema-valid| B[Central browser policy<br/>title → scenes → frames → canonical bytes]
      V -->|invalid| E[Inline errors]
      B -->|title ≤65,536 code units + ≤200 scenes + ≤9,000 frames + canonical YAML ≤1 MiB| S[Active validated Story]
      B -->|too large for browser| W[Policy warning / CLI path]

      S --> T[Timeline / render plan]
      T --> P[Remotion Player preview]
      T --> R[Browser renderer]
      A --> UI
      A --> P
      A --> R

      S <--> L[localStorage]
      R --> M[H.264 MP4 Blob]
      M --> DL[Download]
    end

    S -. same domain contract .-> CLI[Local CLI / CI]
    CLI --> RC[Remotion CLI]
    RC --> F[MP4 file]
~~~

## Main interaction sequence

~~~mermaid
sequenceDiagram
    actor User
    participant UI as Web UI
    participant Draft as Editor Draft
    participant Zod as Zod Validator
    participant Policy as Browser Budget
    participant Story as Active Validated Story
    participant Preview as Timeline + Player
    participant Render as Web Renderer
    participant File as MP4 Download

    User->>UI: Choose assets / edit scenes
    UI->>UI: Reject oversized raw title before Story serialization
    UI->>Draft: Update bounded fields
    Draft->>Zod: Validate candidate
    alt schema valid
        Zod->>Policy: Short-circuit title → scenes → frames → canonical YAML bytes
        alt within browser budget
            Policy->>Story: Commit active validated Story
            Story->>Preview: Compile timeline and refresh preview
        else exceeds browser budget
            Policy-->>UI: Keep current Story; retain candidate as pending visual draft
            UI-->>User: Explain browser limit / CLI alternative; disable render
        end
    else schema invalid
        Zod-->>UI: Retain pending visual/YAML draft + show errors
        UI-->>User: Disable Render MP4 until fixed/discarded
    end

    User->>UI: Click Render MP4
    UI->>Story: Read current validated Story
    UI->>UI: Check browser capability + render budget
    UI->>UI: Lock authoring controls
    Story->>Render: Composition + input props
    Render->>Render: Generate frames + encode in browser
    Render->>File: Produce MP4 Blob
    File-->>User: Download
    UI->>UI: Unlock authoring controls
~~~

## Implementation order

| Spec | Deliverable | Depends on |
| --- | --- | --- |
| [WEB-001](./WEB-001-browser-story-boundary.md) | Browser-compatible Story parsing/validation boundary | v0.1 |
| [WEB-002](./WEB-002-web-shell-and-player.md) | Static web app shell with canonical Remotion Player preview | WEB-001 |
| [WEB-003](./WEB-003-visual-story-editor.md) | Central editor state and visual scene authoring | WEB-002 |
| [WEB-004](./WEB-004-asset-catalog.md) | Discoverable asset catalog and asset-first selection UX | WEB-003 |
| [WEB-005](./WEB-005-yaml-and-persistence.md) | YAML workflow, import/export, and local persistence | WEB-003 |
| [WEB-006](./WEB-006-browser-rendering.md) | Browser-side H.264 MP4 render and download | WEB-004, WEB-005 |
| [WEB-007](./WEB-007-static-deploy-and-verification.md) | Static deployment and end-to-end web MVP verification | WEB-006 |

Specs are sequential where a dependency is listed. Do not pull cloud infrastructure, AI features, or generic editing abstractions into an earlier spec.

## v0.2 UX target

The editor should expose the current engine vocabulary directly:

- poses: \`formal\`, \`confused\`, \`panic\`, \`coffee\`;
- backgrounds: \`office\`, \`server-room\`;
- explicit animations: \`fade\`, \`float\`, \`slowZoom\`;
- scene presets: \`intro\`, \`dialogue\`, \`chaos\`, \`punchline\`;
- text and duration per scene.

The user should be able to understand what can be used without reading documentation or remembering enum values.

## Non-goals

The following remain outside the v0.2 Web Authoring MVP:

- authentication or user accounts;
- collaborative editing;
- backend/database persistence;
- cloud rendering or render queues;
- LLM Writer / Director agents;
- TTS, music, sound effects, or audio timelines;
- dynamic image generation;
- arbitrary asset upload or custom character packs;
- keyframe/timeline editing;
- multiple video aspect ratios;
- batch rendering;
- source-code editing in the browser;
- \`@remotion/browser-bundler\` or an in-browser code compiler.

The web editor edits Story data, not React/Remotion source code.

## Web MVP exit criteria

v0.2 is complete only when all of the following are true:

- a clean checkout can run both the existing CLI workflow and the web app;
- the web app can be built into static files;
- the canonical story opens in a 9:16 Remotion Player;
- the user can add, edit, reorder, and remove scenes visually;
- available poses, backgrounds, and animations are visible and selectable;
- any pending editor candidate that has not become the active Story—because it is schema-invalid, browser-policy-ineligible, or unapplied YAML—produces actionable feedback and disables MP4 export until resolved or discarded;
- YAML can be imported, validated, edited, and exported without changing the Story contract; pasted/edited YAML is rejected by a cheap **1,048,576 UTF-16-code-unit** precheck before `TextEncoder`, then by the exact 1 MiB UTF-8 guard before YAML parsing; file imports use `File.size` before reading;
- editor mode switches, Reset, and import never discard or fork work silently: dirty YAML requires Apply/Discard/Stay before visual mode; invalid visual drafts require Discard/Stay before YAML; browser-policy-rejected visual candidates may be transferred explicitly into YAML, discarded, or kept in visual mode; Reset and validated import cannot replace pending or unpersisted loss-risk work without explicit destructive confirmation;
- when browser persistence succeeds, startup first bounds the raw storage envelope, then parses/version-checks it, applies a cheap pre-Zod storage preflight, then StorySchema, and only surviving schema-valid candidates enter the ordered browser authoring policy; oversized, malformed, unsupported-version, preflight-rejected, and schema-invalid stored data are all quarantined as **raw protected recovery** exportable verbatim as neutral raw text, while schema-valid policy-rejected Stories remain YAML-exportable recovery snapshots; exactly one same-origin old/new bundle may write shared storage under the unversioned persistence lock, while secondary tabs remain session-only until they safely acquire persistence ownership;
- a supported browser can render the canonical story to a **video-only** H.264 MP4 when Remotion capability detection resolves the output target to `web-fs`; after render, the OPFS-backed result must be materialized into an **independent in-memory Blob** before any render file is deleted. v0.2 budgets at most **256 MiB of peak additional payload memory** for this two-copy materialization strategy, which derives a **128 MiB maximum encoded MP4 artifact size**. Browser renders are serialized across same-origin tabs with a dedicated Web Lock, explicit Cancel uses `AbortController`, and the same awaitable OPFS cleanup helper must positively empty `__remotion_render:` before every render starts and again after success/failure/cancel/materialization;
- authoring controls are locked for the lifetime of an in-flight browser render so the completed MP4 cannot become stale relative to the visible Story;
- the web render matches the Story timing/dimensions used by the CLI, caption alignment/wrapping parity is verified for canonical, long, and unbroken text fixtures rather than assumed from shared React code, and caption-font readiness uses bounded batched loading (one full-text load per required weight) rather than per-character font loads;
- unsupported browser rendering capability is detected and explained before starting a render;
- browser authoring rejects raw visual titles above 65,536 UTF-16 code units and raw visual captions above 360 UTF-16 code units before Story validation; once a visual candidate reaches 201 scenes, Add is disabled until the user deletes/reduces/discards/transfers it; visual/YAML/import candidates that reach StorySchema and every stored candidate that survives raw/version/preflight/StorySchema use one centralized short-circuit policy in the order **title → scene count → derived frames → canonical YAML bytes**; over-budget Stories never mount into the live visual editor/Player;
- every Active Story exported as canonical YAML is ≤1 MiB UTF-8 and can therefore pass the browser's own pre-parse import guard;
- browser MP4 export rechecks that the active Story is still within the same 300-second / 9,000-frame browser ceiling, requires `resolvedOutputTarget === "web-fs"`, and passes `muted: true` to both capability detection and rendering so the v0.2 video-only output contains no audio track;
- reload/navigation/tab close warns before discarding session-only authoring state or any in-memory Story that is not durably persisted, including fallback edits whose autosave is suppressed while a recovery slot is protected;
- YAML and MP4 downloads use one bounded deterministic basename sanitizer so Story titles cannot create invalid or platform-dependent filenames, including Win32 `COM¹/²/³` and `LPT¹/²/³` device aliases;
- production documentation discloses Remotion client-render telemetry and records the license basis/current client-safe license-key configuration;
- no custom Tora backend is required to use the application, but browser rendering must not be described as fully offline because Remotion client renders emit upstream telemetry.

## Remotion constraint

The repository currently pins Remotion packages to \`4.0.529\`. New \`@remotion/*\` packages added for this roadmap should stay on the exact same Remotion version unless a dedicated upgrade is intentionally performed.

Client-side rendering through \`@remotion/web-renderer\` is stable in the current pinned range and uses browser WebCodecs. Browser capability must still be checked at runtime before offering MP4 export.
