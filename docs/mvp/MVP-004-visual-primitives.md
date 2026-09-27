# MVP-004 — Visual primitives and scene presets

## Goal

Turn the generic timeline into a recognizable Tora video while keeping the rendering model composable.

## Required assets

The MVP needs only six image assets:

~~~text
public/
├── characters/
│   └── tora/
│       ├── formal.png
│       ├── confused.png
│       ├── panic.png
│       └── coffee.png
└── backgrounds/
    ├── office.png
    └── server-room.png
~~~

Tora pose files should use transparent backgrounds.

If final illustrated backgrounds are not ready, deterministic local placeholders may be used temporarily, but MVP completion requires the two named backgrounds to resolve locally.

## Asset mapping

Use explicit maps rather than dynamic filesystem discovery:

~~~ts
const toraPoses = {
  formal: "...",
  confused: "...",
  panic: "...",
  coffee: "...",
} as const;
~~~

and equivalent mapping for backgrounds.

This keeps asset resolution obvious and aligned with the Zod enums.

## Components

Implement only the primitives required by the reference story:

~~~text
Tora
Background
Caption
Scene
~~~

### Tora

Responsibilities:

- resolve pose asset;
- render transparent character art;
- accept presentation transforms supplied by the scene.

### Background

Responsibilities:

- resolve the named background;
- fill the complete frame;
- use deterministic sizing/cropping.

### Caption

Responsibilities:

- render readable text in the safe vertical-video area;
- wrap long lines;
- remain legible over both MVP backgrounds.

### Scene

Composes Background + Tora + Caption and applies a scene preset and optional animation.

## Scene presets

Treat scene types as presentation presets, not four independent rendering architectures.

Example configuration:

~~~ts
const scenePresets = {
  intro: {
    caption: "hero",
    defaultAnimation: "fade",
  },
  dialogue: {
    caption: "dialogue",
    defaultAnimation: "float",
  },
  chaos: {
    caption: "impact",
  },
  punchline: {
    caption: "hero",
    defaultAnimation: "slowZoom",
  },
} as const;
~~~

The exact visual values can evolve. What matters is that the mapping is centralized and scene types remain declarative.

If \`scene.animation\` is present, it overrides the preset default.

## Animations

Implement exactly three reusable animation primitives:

### fade

Opacity transition at scene entry. A small exit fade is optional.

### float

Subtle continuous vertical movement appropriate for static character art.

### slowZoom

Small scale increase across the scene.

Animations must depend only on Remotion frame/timing data and their explicit parameters.

Avoid randomness.

## Layout

Use one coherent vertical layout system:

~~~text
┌────────────────────────┐
│                        │
│       background       │
│                        │
│         TORA           │
│                        │
│                        │
│       caption          │
│                        │
└────────────────────────┘
~~~

Presets may vary scale and caption treatment, but should not require unrelated component trees.

## Acceptance criteria

- all four Tora poses render from local assets;
- both backgrounds render from local assets;
- captions are readable and remain inside the frame;
- all four scene types produce visibly distinct presentation presets;
- \`fade\`, \`float\` and \`slowZoom\` work and are reusable across scenes;
- YAML-selected pose/background/animation changes visual output without React changes;
- rendering is deterministic;
- no remote asset fetch occurs.

## Out of scope

- props;
- particle effects;
- alarm effect;
- sound;
- music;
- text-to-speech;
- multiple caption component systems unless required by the four presets;
- responsive support for non-vertical formats.

## Done when

The in-memory/reference story looks like a coherent short Tora video rather than a renderer test.
