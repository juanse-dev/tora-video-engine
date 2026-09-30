# WEB-003 — Visual Story editor

> Status: **Proposed**

## Goal

Turn the static web shell into a usable visual editor for the current Story schema while preserving validated Story as the only renderable domain object.

## User-visible outcome

A user can change the title and scene list through normal controls and immediately see valid changes reflected in the preview.

## State model

The UI needs two distinct concepts:

~~~text
Editor Draft
   │
   ├── may be temporarily invalid while the user types
   │
   ↓
StorySchema.safeParse()
   │
   ├── invalid → field errors, do not publish
   │
   └── valid
          ↓
    Validated Story
          ↓
  timeline / preview / persistence / render
~~~

This distinction is required for normal editing behavior. For example, a user must be able to temporarily empty a text field while replacing its content without an invalid Story reaching the renderer.

Do not introduce a second permanent domain model. Draft state is a UI concern only.

## Scope

Create a visual editor for:

### Story

- title.

### Scene

- type;
- pose;
- background;
- animation;
- text;
- duration.

Support:

- selecting a scene;
- adding a scene;
- deleting a scene;
- reordering scenes;
- editing all supported fields;
- displaying validation errors near the relevant field;
- updating the preview whenever the draft produces a new valid Story.

## Enum controls

Options must come from shared domain constants or a typed catalog, not from duplicated freehand arrays in UI components.

The visual editor should never allow arbitrary values for:

- scene type;
- pose;
- background;
- animation.

For \`animation\`, the UI must preserve the existing optional semantics. An “Auto / scene default” UI value may map to an omitted \`animation\` field; it must not invent a new Story enum value.

## Scene operations

### Add

A newly added scene must start from a valid, documented default so the Story can remain usable immediately.

### Delete

The Story schema requires at least one scene. The UI must either:

- disable deletion of the final scene; or
- replace it with a valid default scene.

Prefer the simpler behavior.

### Reorder

Reordering must change Story scene order directly. Absolute frame offsets must continue to be derived by the timeline compiler.

## Validation behavior

- invalid draft values are visible to the user;
- the render/export path never receives invalid draft state;
- MP4 rendering is disabled while the visible visual draft is invalid, so the user cannot accidentally export the previous validated Story as if it included the current edits;
- the UI must not silently coerce arbitrary invalid text/numbers into different valid values;
- field/path information from Zod should be mapped to human-readable editor errors where possible.

## Preview behavior

When a draft is invalid:

- show the validation problem prominently;
- do not render the invalid candidate;
- the Player may keep the last valid Story visible, but it must be visually clear that the preview is not reflecting the invalid draft.

## Tests

Add automated coverage for state/domain transformations where practical:

- edit text;
- change each enum field;
- add scene;
- delete scene;
- reorder scenes;
- invalid duration;
- empty title/text;
- optional/default animation handling.

Avoid large snapshot tests of CSS.

## Acceptance criteria

- every current Story field is editable visually;
- scene order can be changed without React renderer changes;
- valid edits update the Player;
- invalid drafts show actionable errors, do not update the validated Story, and disable MP4 rendering until fixed;
- at least one scene always remains;
- scene duration continues to drive derived frame timing;
- UI option sets cannot drift silently from the Story schema;
- CLI and v0.1 tests remain green.

## Out of scope

- thumbnail asset catalog UX;
- YAML text editing;
- local persistence;
- MP4 browser export;
- freeform timeline/keyframes;
- custom assets.

## Done when

A non-technical user can construct a valid Story without writing YAML, and the renderer still consumes exactly the same validated Story contract.
