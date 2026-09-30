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
4. **Transient editor state is not render state.** UI controls and YAML text may be temporarily invalid, but only a validated \`Story\` can reach preview/persistence/rendering. MP4 rendering must be disabled whenever the visible editor has invalid or unapplied changes so a stale validated Story cannot be exported by mistake.
5. **Assets remain deterministic.** v0.2 uses the repository's bundled Tora poses and backgrounds; no network-generated media is required.
6. **Static hosting only.** The MVP must not require application servers, serverless functions, databases, authentication, or cloud rendering.
7. **No speculative editor platform.** Build the smallest visual authoring experience for the current Story schema.

## System architecture

~~~mermaid
flowchart LR
    U[User] --> UI[Web UI]

    H[Static hosting<br/>Netlify / Cloudflare Pages / GitHub Pages] --> UI
    H --> A[Static asset catalog]

    subgraph Browser
      UI --> D[Editor draft]
      D --> V[Zod validation]
      V -->|valid| S[Validated Story]
      V -->|invalid| E[Inline errors]

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
    participant Story as Validated Story
    participant Preview as Timeline + Player
    participant Render as Web Renderer
    participant File as MP4 Download

    User->>UI: Choose assets / edit scenes
    UI->>Draft: Update fields
    Draft->>Zod: Validate candidate
    alt valid
        Zod->>Story: Commit validated Story
        Story->>Preview: Compile timeline and refresh preview
    else invalid
        Zod-->>UI: Show field/YAML errors
        UI-->>User: Disable Render MP4 until fixed/discarded
    end

    User->>UI: Click Render MP4
    UI->>Story: Read current validated Story
    Story->>Render: Composition + input props
    Render->>Render: Generate frames + encode in browser
    Render->>File: Produce MP4 Blob
    File-->>User: Download
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
- invalid or unapplied draft data produces actionable feedback, never reaches rendering, and disables MP4 export until fixed, applied, or discarded;
- YAML can be imported, validated, edited, and exported without changing the Story contract;
- the last valid project is restored locally on reload;
- a supported browser can render the canonical story to an H.264 MP4 and download it;
- the web render matches the Story timing/dimensions used by the CLI;
- unsupported browser rendering capability is detected and explained before starting a render;
- no custom backend is required to use the application.

## Remotion constraint

The repository currently pins Remotion packages to \`4.0.529\`. New \`@remotion/*\` packages added for this roadmap should stay on the exact same Remotion version unless a dedicated upgrade is intentionally performed.

Client-side rendering through \`@remotion/web-renderer\` is stable in the current pinned range and uses browser WebCodecs. Browser capability must still be checked at runtime before offering MP4 export.
