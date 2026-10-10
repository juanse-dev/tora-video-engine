# Tora Video Engine

Tora Video Engine is a small declarative video renderer and local-first browser authoring tool built with Remotion. The same validated `Story` drives the local CLI, Remotion Player preview, and browser-side H.264 MP4 rendering.

> Status: **v0.1 renderer complete; v0.2 Web Authoring MVP complete and deployed.** Production: `https://tora-video-engine.netlify.app`. The v0.1 reference render is accepted in [MVP-006](docs/mvp/MVP-006-reference-story-and-verification.md), and the v0.2 acceptance record lives in [docs/web/](docs/web/README.md).

## MVP flow

```text
story.yaml
  ↓
loadStory()
  ↓
Zod validation
  ↓
Story
  ↓
compileTimeline()
  ↓
StoryRenderer
  ↓
Scene
  ↓
Remotion
  ↓
MP4
```

The implementation roadmap and acceptance criteria live in [docs/mvp/](docs/mvp/README.md). Those specs are the source of truth for v0.1.

## Web authoring flow

```text
bundled assets + visual/YAML editor
                ↓
        validated Story
                ↓
       Remotion Player
                ↓
 browser H.264 MP4 render
                ↓
           download
```

The v0.2 web app is intentionally single-user, local-first, backend-free, and root-path hosted. Local persistence uses browser storage; browser rendering uses the same Story/timeline/components as the CLI.

## Install

```bash
npm install
```

Requires Node.js >=22.6.0.

## Render a story

```bash
npm run video -- stories/friday-deploy.yaml
```

This validates the YAML before rendering and writes:

```text
output/friday-deploy.mp4
```

The output filename is derived deterministically from the input filename. Re-running the command replaces that same output. A failed validation or render does not leave a stale MP4 behind.

## Render with local images

Stories can reference your own PNG, JPEG or WebP images as `local:pose:sha256:<digest>` / `local:background:sha256:<digest>` (see [docs/assets/README.md](docs/assets/README.md)). The CLI finds the matching files by content (SHA-256), not by name, in the gitignored `local-assets/` folder:

```text
local-assets/
  poses/         images usable as local:pose:sha256:...
  backgrounds/   images usable as local:background:sha256:...
```

```bash
npm run assets
npm run video -- stories/my-story.yaml
```

- `npm run assets` lists every file in `local-assets/` with the `local:...` ref to paste into a Story, or why a file was skipped (not a static PNG/JPEG/WebP, over 25 MiB, over 8192 px per side or 50 million pixels in total, animated, damaged).
- Browser to CLI: export the Story YAML from the web app, copy the exact original image files into `local-assets/poses/` or `local-assets/backgrounds/` (any filename, subfolders allowed, symbolic links are skipped), then run `npm run video`.
- If a referenced image is missing, the render stops before Remotion starts and lists each missing ref, the scenes that use it and the folder that was searched. Nothing falls back to another image.
- The images are copied into a temporary public directory for the render and removed afterwards; `public/` and the originals are never modified. Bundled-only Stories render exactly as before.
- `TORA_LOCAL_ASSETS_ROOT` overrides the `local-assets` folder (used by tests and CI).

## Web app

Run the local Vite authoring app:

```bash
npm run web:dev
```

Build the deployable static site:

```bash
npm run web:build
```

Preview the production build locally:

```bash
npm run web:preview
```

The static output is written to `dist/web`. The repository includes `netlify.toml` for a root-hosted Netlify deployment using `npm run web:build`; no Netlify Functions are required.

Browser MP4 export is enabled only when runtime capability detection confirms the Web Locks API, H.264 client rendering, and Remotion's `web-fs` output target. If browser rendering is unavailable, visual/YAML authoring, Player preview, YAML export, and the local CLI remain usable.

Client-side Remotion rendering emits mandatory licensing telemetry and must not be described as fully offline. Production licensing/privacy details and the release checklist are documented in [docs/web/production-deployment.md](docs/web/production-deployment.md).

## Remotion Studio

```bash
npm run dev
```

Studio opens the same canonical reference story used by the MVP tests.

## Validate the repository

```bash
npm test
npm run lint
npm run web:build
npm run test:browser
npm run test:cli-e2e
```

`npm run test:cli-e2e` renders a Story from `local-assets/`-style folders for real; it needs Chrome (set `TORA_REMOTION_BROWSER_EXECUTABLE` if Remotion cannot find one).

CI also verifies the static web artifact, runs the browser-render golden, exercises the production Player/browser flow, renders the CLI smoke/reference Story, renders a Story with local assets end to end (`npm run test:cli-e2e`), and verifies that invalid input cannot leave a stale MP4 behind.

## v0.1 story format

The canonical fixture is [stories/friday-deploy.yaml](stories/friday-deploy.yaml):

```yaml
title: "Deploy Friday"

scenes:
  - type: intro
    pose: formal
    background: office
    animation: fade
    text: "Tora tiene una regla: Nunca desplegar en viernes."
    duration: 3

  - type: dialogue
    pose: confused
    background: office
    animation: float
    text: Pero es solo un cambio pequeño... qué es lo peor que podría pasar?
    duration: 3

  - type: chaos
    pose: panic
    background: server-room
    text: Se cayó el sistema!
    duration: 3

  - type: punchline
    pose: coffee
    background: office
    animation: slowZoom
    text: "Era un cambio pequeño."
    duration: 3
```

At 30 FPS it compiles to four 90-frame scenes and a total duration of 360 frames / 12 seconds.

### Supported values

- Scene types: `intro`, `dialogue`, `chaos`, `punchline`
- Tora poses: `formal`, `confused`, `panic`, `coffee`
- Backgrounds: `office`, `server-room`
- Animations: `fade`, `float`, `slowZoom`
- Duration: explicit positive seconds
- Output: 1080×1920, 30 FPS, H.264 MP4

Changing scene order, caption text, duration, pose, background, or animation in YAML changes the render plan consumed by `StoryRenderer`/`Scene` without requiring React changes.

## Architecture

```text
stories/
  friday-deploy.yaml

src/
  story/
    schema.ts
    loadStory.ts
    timeline.ts
  components/
    Tora.tsx
    Background.tsx
    Caption.tsx
  animations/
    fade.ts
    float.ts
    slowZoom.ts
  Scene.tsx
  StoryRenderer.tsx
  Video.tsx
  Root.tsx

scripts/
  render.ts
  renderSupport.ts
```

The main boundary is the validated `Story` object. YAML/file I/O stays outside React.

## Out of scope for v0.1

The MVP intentionally does not include:

- LLM Writer/Director agents;
- TTS, music, or sound effects;
- props or effects;
- dynamic image generation;
- character packs or multiple characters;
- automatic scene duration;
- word-level subtitles;
- landscape/square formats;
- batch/cloud rendering;
- a globally installed `tora` CLI.

These belong to later phases after the deterministic renderer is stable.

## Roadmap

The completed v0.1 sequence is:

1. Remotion bootstrap.
2. Story domain and timeline.
3. YAML input and validation.
4. Visual primitives and scene presets.
5. One-command YAML → MP4 rendering.
6. Reference story and verification.

The v0.2 Web Authoring sequence is:

1. Browser-safe Story boundary.
2. Static web shell and Remotion Player.
3. Visual Story editor.
4. Discoverable asset catalog.
5. YAML workflow and local persistence.
6. Browser-side H.264 MP4 rendering.
7. Static deployment and production verification — **complete**.

See [docs/web/README.md](docs/web/README.md) for the source-of-truth architecture and acceptance criteria.

v0.3 Local Custom Assets is in progress (see [docs/assets/README.md](docs/assets/README.md)). Complete: ASSET-001 (local asset references, persistence v2 and the composition contract), ASSET-002 (image inspection, hashing and the browser asset library), ASSET-004 (preview and browser MP4 rendering with local assets) and ASSET-005 (CLI rendering with local assets). Importing local assets in the browser arrives with ASSET-003 (the My assets UI).
