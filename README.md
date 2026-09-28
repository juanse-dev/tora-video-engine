# Tora Video Engine

Tora Video Engine is a small declarative video renderer built with Remotion. The v0.1 MVP turns a validated YAML story into a deterministic vertical H.264 MP4.

> Status: **v0.1 MVP complete**. The canonical reference render passes automated verification and the final visual checklist in [MVP-006](docs/mvp/MVP-006-reference-story-and-verification.md).

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

## Remotion Studio

```bash
npm run dev
```

Studio opens the same canonical reference story used by the MVP tests.

## Validate the repository

```bash
npm test
npm run lint
```

CI additionally renders the canonical story with the real `npm run video` command, verifies the MP4 exists and is non-empty, uploads the reference render as an artifact, and verifies that invalid input cannot leave a stale output.

## v0.1 story format

The canonical fixture is [stories/friday-deploy.yaml](stories/friday-deploy.yaml):

```yaml
title: "Deploy Friday"

scenes:
  - type: intro
    pose: formal
    background: office
    animation: fade
    text: "Tora tiene una regla."
    duration: 3

  - type: dialogue
    pose: confused
    background: office
    animation: float
    text: "Pero es solo un cambio pequeño..."
    duration: 3

  - type: chaos
    pose: panic
    background: server-room
    text: "Production is down."
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

Future work can build on this renderer with richer assets, audio, content-generation tooling, and eventually AI-assisted Writer/Director workflows without changing the v0.1 contract.
