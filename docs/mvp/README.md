# MVP roadmap

This directory is the implementation plan for **Tora Video Engine v0.1**.

The MVP has one promise:

~~~text
story.yaml → validated story → Remotion timeline → MP4
~~~

Everything in this roadmap exists to prove that vertical slice with the smallest useful implementation.

## Definition of MVP

Given a valid YAML story, the project can render a deterministic vertical H.264 video containing multiple scenes, Tora poses, reusable backgrounds, captions, and basic motion.

Target:

- 1080 × 1920;
- 30 FPS;
- YAML input;
- H.264 MP4 output;
- one character: Tora;
- four poses: formal, confused, panic, coffee;
- two backgrounds: office, server-room;
- four scene presets: intro, dialogue, chaos, punchline;
- three animations: fade, float, slowZoom;
- explicit scene duration in seconds.

The reference flow must work with:

~~~bash
npm run video -- stories/friday-deploy.yaml
~~~

and produce:

~~~text
output/friday-deploy.mp4
~~~

## Non-goals

The following are explicitly outside v0.1:

- LLM integration;
- Writer / Director agents;
- Text-to-Speech;
- music and sound effects;
- props;
- dynamic image generation;
- character packs;
- multiple characters;
- custom CLI such as \`tora render\`;
- automatic scene duration;
- subtitles synchronized with audio;
- square or landscape output;
- remote rendering or cloud infrastructure.

These features may influence future architecture, but they must not increase the MVP implementation surface.

## Implementation order

| Spec | Deliverable | Depends on |
| --- | --- | --- |
| ✅ [MVP-001](./MVP-001-bootstrap-remotion.md) | Runnable Remotion project and static vertical composition | — |
| ✅ [MVP-002](./MVP-002-story-domain-and-timeline.md) | In-memory story model and data-driven timeline | MVP-001 |
| ✅ [MVP-003](./MVP-003-yaml-and-validation.md) | YAML loading and Zod validation | MVP-002 |
| ✅ [MVP-004](./MVP-004-visual-primitives.md) | Tora, backgrounds, captions, presets and animations | MVP-002 |
| ✅ [MVP-005](./MVP-005-render-command.md) | One-command YAML → MP4 rendering | MVP-003, MVP-004 |
| ✅ [MVP-006](./MVP-006-reference-story-and-verification.md) | Golden story, tests and MVP exit criteria | MVP-005 |

Specs are intentionally sequential. Avoid implementing later phases while an earlier acceptance criterion is still failing.

## Architecture boundary

For v0.1, keep the architecture intentionally small:

~~~text
YAML file
   ↓
loadStory()
   ↓
Zod schema
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
~~~

The main domain boundary is the validated \`Story\` object. File parsing should happen before rendering; React components should not read YAML directly.

## Proposed MVP structure

~~~text
tora-video-engine/
├── public/
│   ├── characters/
│   │   └── tora/
│   │       ├── formal.png
│   │       ├── confused.png
│   │       ├── panic.png
│   │       └── coffee.png
│   └── backgrounds/
│       ├── office.png
│       └── server-room.png
│
├── stories/
│   └── friday-deploy.yaml
│
├── src/
│   ├── components/
│   │   ├── Tora.tsx
│   │   ├── Background.tsx
│   │   └── Caption.tsx
│   ├── animations/
│   │   ├── fade.ts
│   │   ├── float.ts
│   │   └── slowZoom.ts
│   ├── story/
│   │   ├── schema.ts
│   │   ├── loadStory.ts
│   │   └── timeline.ts
│   ├── Scene.tsx
│   ├── StoryRenderer.tsx
│   ├── Video.tsx
│   └── Root.tsx
│
├── scripts/
│   └── render.ts
│
├── docs/
│   └── mvp/
├── output/
├── package.json
└── README.md
~~~

This structure is a target, not a constraint. Prefer deleting abstractions over adding layers that are not required by the specs.

## Cross-cutting rules

1. **The renderer consumes validated data.** Invalid YAML must fail before Remotion rendering starts.
2. **Timing is derived.** Stories specify durations, not absolute frame offsets.
3. **Scene types are presets.** Do not create four unrelated rendering systems if a single \`Scene\` component plus configuration is sufficient.
4. **Assets are local and deterministic.** The MVP must render without network access.
5. **No speculative abstractions.** Build only extension points that the MVP actually exercises.
6. **A completed spec leaves the repository runnable.**

## MVP exit criteria

v0.1 is complete only when all of the following are true:

- a fresh checkout can install dependencies and open Remotion Studio;
- \`stories/friday-deploy.yaml\` passes validation;
- changing scene order, text, pose, background, animation or duration in YAML changes the resulting video without React changes;
- invalid scene types, poses, backgrounds and non-positive durations fail with useful errors;
- timeline start frames and total duration are derived from scene durations;
- \`npm run video -- stories/friday-deploy.yaml\` creates an MP4 in \`output/\`;
- the reference video contains all four scene presets and required assets;
- core schema and timeline behavior have automated tests;
- the README points to these specs as the source of truth for MVP development.

Anything beyond these criteria belongs after v0.1.
