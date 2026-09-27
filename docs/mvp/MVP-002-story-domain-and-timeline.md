# MVP-002 — Story domain and timeline

## Goal

Replace the static composition with a data-driven story rendered from an in-memory TypeScript object.

This spec establishes the core engine boundary without adding file parsing.

## Story model

Start with the smallest useful domain model:

~~~ts
type SceneType = "intro" | "dialogue" | "chaos" | "punchline";

type Pose =
  | "formal"
  | "confused"
  | "panic"
  | "coffee";

type Background =
  | "office"
  | "server-room";

type Animation =
  | "fade"
  | "float"
  | "slowZoom";

type StoryScene = {
  type: SceneType;
  pose: Pose;
  background: Background;
  text: string;
  duration: number; // seconds
  animation?: Animation;
};

type Story = {
  title: string;
  scenes: StoryScene[];
};
~~~

These types may later be inferred from Zod, but the domain shape must remain equivalent for the MVP.

## Timeline compilation

A story contains relative durations, never absolute frame positions.

Create a pure timeline function conceptually equivalent to:

~~~ts
type TimelineScene = StoryScene & {
  from: number;
  durationInFrames: number;
};

type Timeline = {
  scenes: TimelineScene[];
  durationInFrames: number;
};
~~~

For each scene:

~~~text
durationInFrames = round(durationSeconds × fps)
from = sum(previous durationInFrames)
~~~

At 30 FPS:

~~~text
3 s → 90 frames
2 s → 60 frames
4 s → 120 frames
~~~

Example:

~~~text
Scene A: from 0   duration 90
Scene B: from 90  duration 60
Scene C: from 150 duration 120
Total: 270 frames
~~~

## Rendering

Implement a \`StoryRenderer\` that receives a validated/in-memory \`Story\` and creates Remotion \`Sequence\` entries using the compiled timeline.

At this stage, a generic temporary \`Scene\` component is sufficient. Different scene types may display their type name but do not need final visual styling.

## Root composition duration

The composition duration must be derived from the story rather than hardcoded.

Choose the simplest mechanism supported by the installed Remotion version to set composition metadata from the input story.

## Deliverables

Suggested files:

~~~text
src/
├── story/
│   └── timeline.ts
├── Scene.tsx
├── StoryRenderer.tsx
├── Video.tsx
└── Root.tsx
~~~

Add an in-memory example story for development.

## Tests

Timeline calculation is pure business logic and should have automated unit tests.

Minimum cases:

- one scene;
- multiple scenes;
- fractional seconds;
- cumulative \`from\` values;
- correct total duration.

## Acceptance criteria

- the video is generated from a TypeScript \`Story\` object;
- changing scene order in the object changes video order;
- changing a scene duration changes both its sequence duration and subsequent start frames;
- composition duration equals the sum of scene durations;
- no scene contains an explicit absolute frame offset;
- timeline calculation is unit tested;
- Remotion Studio can still preview the composition.

## Out of scope

- reading files;
- runtime schema validation;
- final Tora visuals;
- render wrapper;
- AI or audio.

## Done when

The repository has a small deterministic engine capable of translating an in-memory story into a valid Remotion timeline.
