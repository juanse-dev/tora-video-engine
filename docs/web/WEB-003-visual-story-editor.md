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

## Editor ownership and mode transitions

WEB-005 adds a YAML editing mode over the same validated Story. The visual editor must expose whether its current draft differs from the last validated Story and whether that draft is invalid.

If the visual draft is invalid and the user attempts to switch to YAML mode, do not silently replace it with YAML generated from the previous validated Story. Intercept the transition and require one explicit choice:

- **Discard** — discard the invalid visual draft and enter YAML mode from the current validated Story;
- **Stay in visual editor** — cancel the transition and preserve the invalid draft exactly as typed.

There is no Apply option for an invalid visual draft. As soon as visual fields form a valid Story, the normal visual-editor flow commits that Story automatically, after which switching to YAML is safe.

The application must never keep both an invalid visual draft and an independently editable YAML draft at the same time.

## Live caption font updates

WEB-003 changes Story props after the Player has already mounted, including scene caption text. The shared `useCaptionFont(story)` hook must therefore be safe across repeated and overlapping `captionText` changes.

The current one-handle-for-component-lifetime behavior is not sufficient for live editing. Refactor the shared hook so that each caption-text load generation owns its own pending render synchronization and stale async work cannot unblock or cancel a newer generation.

Required behavior:

- a caption change after the initial font load must not reuse a `delayRender` handle that has already been continued;
- each active caption-text generation must settle/retire its own pending handle exactly once;
- cleanup of an obsolete generation must not leave a pending handle that can deadlock rendering;
- a stale successful load must not mark a newer caption generation ready;
- a stale failure must not cancel a newer successful generation;
- rapid A → B → C caption changes before earlier font loads complete must end with C as the active ready generation;
- repeated edits after the initial Player mount must continue to work in both Player preview and deterministic render paths.

Caching already-loaded font coverage is allowed, but it must not weaken the generation/handle ownership rules.

## Browser authoring / preview budget

Schema validity does not by itself mean a Story is safe to mount into the browser editor and Player. `StoryRenderer` creates one Remotion `Sequence` per scene, so an unbounded schema-valid scene array can freeze the tab before WEB-006 render eligibility is even considered.

For v0.2, define centralized browser-authoring limits:

- maximum active scenes: **200**;
- maximum derived total duration: **300 seconds / 9,000 frames at 30 FPS**.

These are browser policy limits, not additions to `StorySchema`.

Before a schema-valid candidate becomes the active validated Story used by the visual editor and Player:

1. derive total frames with the existing timeline/render-plan logic;
2. check scene count and total frames against the browser budget;
3. only commit/mount the candidate when both checks pass.

A schema-valid candidate above either limit:

- remains valid for the engine/CLI;
- must not replace the current live browser Story;
- must not be mounted into `StoryRenderer` / Remotion Player;
- must show an actionable explanation that the browser authoring limit was exceeded;
- should direct the user to YAML/CLI workflows rather than labeling the document schema-invalid.

Keep these limits named and centralized so WEB-005 import and WEB-006 rendering reuse the same browser-policy source of truth.

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
- optional/default animation handling;
- invalid visual draft → YAML mode transition requires Discard/Stay;
- multiple consecutive caption edits after Player mount, including overlapping rapid edits, preserve correct font readiness without stale `delayRender` handles;
- a schema-valid Story at the browser budget boundary can become active;
- a schema-valid Story with 201 scenes is rejected by browser authoring policy before Player mount;
- a schema-valid Story above 9,000 derived frames is rejected by browser authoring policy before Player mount.

Avoid large snapshot tests of CSS.

## Acceptance criteria

- every current Story field is editable visually;
- scene order can be changed without React renderer changes;
- valid edits within the browser authoring budget update the Player;
- invalid drafts show actionable errors, do not update the validated Story, and disable MP4 rendering until fixed;
- schema-valid candidates above 200 scenes or 9,000 frames do not replace/mount the live browser Story and are reported as browser-policy limits, not schema errors;
- attempting to leave an invalid visual draft for YAML requires explicit Discard or Stay, with no silent loss and no parallel YAML draft;
- at least one scene always remains;
- scene duration continues to drive derived frame timing;
- UI option sets cannot drift silently from the Story schema;
- the caption-font hook safely handles multiple sequential and overlapping caption changes after mount;
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
