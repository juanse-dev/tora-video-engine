# MVP-003 — YAML input and validation

> Status: **Implemented** in [PR #3](https://github.com/juanse-dev/tora-video-engine/pull/3). The reference YAML loads through a Node-only parser, validates against the Zod contract, and feeds the existing timeline domain without YAML/filesystem logic leaking into React.

## Goal

Make YAML the external source format and guarantee that only valid stories reach the renderer.

## Input contract

Support a story equivalent to:

~~~yaml
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
~~~

## Schema

Define the external contract with Zod.

Required constraints:

- \`title\`: non-empty string;
- \`scenes\`: at least one scene;
- \`type\`: one of \`intro | dialogue | chaos | punchline\`;
- \`pose\`: one of \`formal | confused | panic | coffee\`;
- \`background\`: one of \`office | server-room\`;
- \`text\`: non-empty string;
- \`duration\`: finite number greater than zero;
- \`animation\`: optional, one of \`fade | float | slowZoom\`.

Prefer deriving TypeScript types from the schema so the runtime and compile-time contracts cannot drift.

## Loader

Implement a Node-side function:

~~~ts
loadStory(path: string): Promise<Story>
~~~

Responsibilities:

1. read the file;
2. parse YAML;
3. validate with Zod;
4. return the typed \`Story\`;
5. fail with a useful error if any step fails.

React components must not read YAML or access the filesystem.

## Error quality

Validation errors should identify enough context to fix the story quickly.

Examples of useful failures:

~~~text
scenes.2.duration: Number must be greater than 0
scenes.1.pose: Invalid enum value "sleepy"
scenes.0.background: Invalid enum value "kitchen"
~~~

Exact Zod wording may differ, but the failing path must be visible.

## Deliverables

Suggested files:

~~~text
src/story/
├── schema.ts
└── loadStory.ts

stories/
└── friday-deploy.yaml
~~~

## Tests

Minimum validation tests:

- valid reference story;
- empty scenes;
- unknown scene type;
- unknown pose;
- unknown background;
- unknown animation;
- missing text;
- zero duration;
- negative duration;
- malformed YAML.

## Acceptance criteria

- \`stories/friday-deploy.yaml\` loads into the same domain shape used by the renderer;
- TypeScript story types are derived from, or mechanically kept consistent with, the runtime schema;
- invalid files fail before Remotion rendering begins;
- validation errors include the failing field path;
- parser and schema behavior are covered by automated tests;
- no YAML-specific logic exists inside React components.

## Out of scope

- JSON input;
- schema versioning;
- migrations;
- defaults for missing duration;
- asset existence checks beyond enum validation;
- arbitrary custom characters or backgrounds.

## Done when

YAML is a trustworthy boundary: after \`loadStory()\` returns, rendering code can treat the story as valid.
