# WEB-003 — Visual Story editor

> Status: **Proposed**

## Goal

Turn the static web shell into a usable visual editor for the current Story schema while preserving validated Story as the only renderable domain object.

## User-visible outcome

A user can change the title and scene list through normal controls and immediately see valid changes reflected in the preview.

## State model

The UI needs three distinct concepts:

~~~text
Raw visual input
   │
   ├── cheap browser field guard
   │   └── oversized title → local policy error; do not build/serialize candidate
   ↓
Visual Candidate
   │
   ├── may be temporarily invalid while the user types
   │
   ↓
StorySchema.safeParse()
   │
   ├── invalid → pending visual draft + field errors
   │
   └── schema-valid
          ↓
   Browser policy check
          │
          ├── over budget → pending visual draft + policy error
          │
          └── eligible
                 ↓
          Active Validated Story
                 ↓
     timeline / preview / persistence / render
~~~

This distinction is required for normal editing behavior. A pending visual draft can exist for two reasons: schema-invalid input while typing, or a schema-valid candidate rejected by browser authoring policy. In both cases the previously active Story may remain visible in the Player, but it is not the same content the user is currently editing.

Do not introduce another permanent domain model. Candidate/draft state is a UI concern only; the active validated Story remains the only browser render/persistence input.

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

The browser policy allows **200 active scenes**, but the visual editor intentionally permits creation of the **201st** scene so the user can see and resolve the first over-budget pending state. That does not permit unbounded draft growth.

Required behavior:

- when the current visual candidate has fewer than 201 scenes, Add may create the next scene normally;
- once the candidate has **201 scenes**, disable Add and refuse any further scene-growth operation;
- keep edit, delete, reorder, and explicit YAML-transfer/discard actions available so the user can recover from the pending over-budget state;
- deleting back to 200 scenes re-enables Add;
- do not allocate/render placeholder editor rows for scenes beyond this 201-scene draft ceiling.

This **201-scene visual-draft ceiling** is a UI resource guard, not a change to `StorySchema` or the 200-scene Active Story policy.

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
- MP4 rendering is disabled whenever the visual candidate differs from the active Story because it is schema-invalid or browser-policy-ineligible, so the previous active Story cannot be exported as if it included the current edits;
- the UI must not silently coerce arbitrary invalid text/numbers into different valid values;
- field/path information from Zod should be mapped to human-readable editor errors where possible.

## Editor ownership and mode transitions

WEB-005 adds a YAML editing mode over the same active validated Story. The visual editor must expose whether its current candidate differs from the active Story and why it has not been committed: schema-invalid or browser-policy-ineligible.

If the visual draft is invalid and the user attempts to switch to YAML mode, do not silently replace it with YAML generated from the previous validated Story. Intercept the transition and require one explicit choice:

- **Discard** — discard the invalid visual draft and enter YAML mode from the current validated Story;
- **Stay in visual editor** — cancel the transition and preserve the invalid draft exactly as typed.

There is no Apply option for an invalid visual draft. As soon as visual fields form a schema-valid and browser-eligible Story, the normal visual-editor flow commits that Story automatically.

For a schema-valid but browser-policy-rejected visual candidate, WEB-005 may offer an explicit **Open candidate in YAML** transition that serializes/transfers that exact candidate into the YAML buffer. The transition may carry provenance that this exact buffer came from the already schema-validated visual candidate so WEB-005 can export the unchanged candidate without redundant reparsing; the transferred buffer must still satisfy the normal 1 MiB browser source-size ceiling. Any subsequent YAML edit invalidates that provenance. Otherwise the user must Discard or Stay in the visual editor. Never generate YAML from the older active Story while silently dropping the rejected candidate.

The application must never keep both a pending visual draft and an independently editable YAML draft at the same time.

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

## Cheap pre-schema visual input guards

The visual editor must reject obviously impossible oversized text **before** constructing a Story candidate or invoking Zod/font-coverage work.

### Title

The shared schema intentionally leaves `Story.title` unbounded. Define a browser-only visual title limit of **65,536 UTF-16 code units**, checked using the raw JavaScript string length.

- inspect the proposed title before calling `StorySchema.safeParse()`, timeline derivation, or `serializeStorySource()`;
- if `nextTitle.length > 65_536`, reject that visual update as a browser-policy input error and keep the last accepted candidate/active Story unchanged;
- do not truncate or otherwise silently coerce the title;
- show an actionable field-level message that the browser editor limit was exceeded and that CLI/YAML remains the path for larger schema-valid titles.

### Scene caption

`StoryScene.text` is schema-limited to **180 Unicode code points**, but the schema counts code points/font coverage only after receiving the raw string. A very large paste must not reach those full-string passes.

Define a cheap raw visual caption ceiling of **360 UTF-16 code units**:

- inspect the proposed caption's JavaScript `.length` before constructing the Story candidate or calling `StorySchema.safeParse()` / font-coverage validation;
- reject `rawCaption.length > 360` immediately with a field-level validation message;
- 360 is a safe precheck because any schema-valid 180-code-point caption can occupy at most 360 UTF-16 code units when all code points are surrogate pairs;
- captions at or below 360 code units still pass through normal schema validation, which remains authoritative for the exact 180-code-point constraint;
- never truncate the pasted caption silently.

Any future visual string field whose validity is expensive to establish must receive an equivalent cheap raw guard.

This guard is browser UI policy only and must not change `StorySchema` or the CLI contract. It is an early optimization for the visual source, not the authoritative title-policy check.

## Browser authoring / preview budget

Schema validity does not by itself mean a Story is safe to mount into the browser editor and Player. `StoryRenderer` creates one Remotion `Sequence` per scene, so an unbounded schema-valid scene array can freeze the tab before WEB-006 render eligibility is even considered.

For v0.2, define centralized browser-authoring limits:

- maximum Story title: **65,536 UTF-16 code units for every schema-valid candidate regardless of source**. Visual input additionally performs the cheap pre-construction guard above;
- maximum active scenes: **200**;
- maximum derived total duration: **300 seconds / 9,000 frames at 30 FPS**;
- defensive maximum canonical YAML size: **1 MiB (1,048,576 UTF-8 bytes)**, measured from the exact `serializeStorySource(story)` representation introduced by WEB-001. With the current 65,536-title / 200-scene / 180-code-point-caption bounds, this final check is not expected to independently reject a v0.2 Story; it protects the round-trip invariant against future schema/serializer changes.

These are browser policy limits, not additions to `StorySchema`.

Before **any** schema-valid candidate becomes the active validated Story used by the visual editor and Player, call one centralized policy function (for example `evaluateBrowserStoryPolicy(story)`) with this exact short-circuit order:

1. check `story.title.length <= 65_536`;
2. check `story.scenes.length <= 200`;
3. only if both cheap structural checks pass, derive total frames with the existing timeline/render-plan logic and require `totalFrames <= 9_000`;
4. only if the frame check passes, serialize the candidate through the shared canonical `serializeStorySource()`;
5. measure the canonical YAML as UTF-8 bytes and require it to be ≤ 1 MiB;
6. only commit/mount the candidate when every check passes.

The order is part of the contract, not an implementation detail. A title or scene-count failure must return before timeline derivation; a title/scene/frame failure must return before canonical serialization. WEB-005 Apply/import/restore and WEB-006's defensive render-time recheck must call this same ordered policy rather than duplicating the checks independently.

For the visual source, the title check is normally redundant because the cheap raw-input guard already blocked the oversized value. It remains required so all candidate sources share one authoritative policy.

The canonical-size condition is a defensive round-trip invariant: every Story the web app accepts as active must produce a canonical YAML export that the same app can later accept through its 1 MiB pre-parse source guard. Do not create acceptance tests that require a current v0.2 Story to fail **only** this condition; the earlier title/scene/text bounds make that branch effectively unreachable today.

A schema-valid candidate above any browser-authoring limit:

- remains valid for the engine/CLI;
- remains the pending visual candidate so the user can remove scenes/reduce duration or explicitly transfer it to YAML;
- must not replace the current active browser Story;
- must not be mounted into `StoryRenderer` / Remotion Player;
- must disable browser MP4 rendering while it differs from the active Story;
- must show which reachable browser authoring limit was exceeded (title, scene count, or duration/frames); if the defensive canonical-byte invariant ever trips because the schema/serializer evolves, report it as an internal policy/round-trip guard that requires the browser limits to be revisited;
- should direct the user to YAML/CLI workflows rather than labeling the document schema-invalid.

Keep these limits named and centralized so WEB-005 import and WEB-006 rendering reuse the same browser-policy source of truth.

## Preview behavior

When a visual candidate is either schema-invalid or browser-policy-ineligible:

- show the schema/policy problem prominently;
- do not render or persist that candidate;
- disable MP4 export;
- the Player may keep the active Story visible, but it must be visually clear that preview/export do not reflect the pending visual candidate.

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
- a title exactly at 65,536 code units can proceed to the remaining policy checks;
- a 65,537-code-unit visual update is rejected by the cheap pre-construction guard;
- a schema-valid 65,537-code-unit Story arriving from YAML/import/restore is rejected by the centralized post-schema title check before timeline derivation or canonical serialization;
- a schema-valid Story at the remaining browser budget boundary can become active;
- a 201-scene schema-valid candidate is rejected by the centralized policy without invoking timeline derivation or `serializeStorySource()`;
- once the visual draft reaches 201 scenes, repeated Add attempts cannot increase its length; delete back to 200 re-enables Add;
- a multi-megabyte caption paste is rejected by the 360-code-unit raw guard without invoking `StorySchema.safeParse()`, caption code-point counting, or font-coverage validation;
- a schema-valid Story with 201 scenes is retained as a pending visual candidate, rejected by browser authoring policy before Player mount, and disables MP4 rendering;
- a schema-valid Story above 9,000 derived frames is retained as a pending visual candidate, rejected by browser authoring policy before Player mount, and disables MP4 rendering;
- raw visual title input above 65,536 code units and raw visual caption input above 360 code units are rejected before Story candidate construction/schema validation;
- a boundary fixture using the maximum v0.2 title/scene/caption shapes still serializes to canonical YAML ≤1 MiB, proving the final size check is defensive under the current constraints;
- every browser-eligible active Story serializes to canonical YAML ≤1 MiB and can be parsed again after export/import.

Avoid large snapshot tests of CSS.

## Acceptance criteria

- every current Story field is editable visually;
- scene order can be changed without React renderer changes;
- valid edits within the browser authoring budget update the Player;
- schema-invalid pending visual drafts show actionable errors, do not update the active Story, and disable MP4 rendering until fixed/discarded;
- oversized raw visual title/caption input is stopped before expensive Story validation work; visual drafts cannot grow beyond 201 scenes; every non-visual schema-valid candidate is checked by the centralized policy before timeline/serialization; candidates above reachable scene/frame limits remain pending/rejected and never replace/mount the active Story, while the final canonical-size check remains a defensive invariant;
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
