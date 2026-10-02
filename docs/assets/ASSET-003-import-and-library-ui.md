# ASSET-003 — Import and local asset library UI

> Status: **Proposed**

## Goal

Extend the v0.2 asset catalog so users can discover and use both Tora's bundled images and their own browser-local images without confusing the two inventories.

## Product vocabulary

The catalog presents two origins explicitly:

- **Bundled** — shipped with Tora Video Engine;
- **My assets** — stored only in this browser/site data.

Do not merge both into one unlabeled grid.

The UI should make the local-only nature of My assets understandable without requiring README knowledge.

## Supported categories

v0.3 custom imports are allowed only for:

- pose / character image;
- background.

Animations remain bundled/editor-defined choices and are not imported files.

## Catalog layout

For the selected scene, the visual hierarchy should be conceptually:

~~~text
POSES

Bundled
[Formal] [Confused] [Panic] [Coffee]

My assets
[My cat] [Formal alt] [+ Import pose]


BACKGROUNDS

Bundled
[Office] [Server room]

My assets
[Apartment] [Bogotá] [+ Import background]
~~~

Existing bundled cards keep their current behavior.

Local cards display:

- thumbnail;
- display label;
- local-origin indicator;
- current-selection state;
- actions for rename/delete.

## Import entry points

Provide category-aware import actions:

- **Import pose**
- **Import background**

The category is selected by the entry point rather than inferred from image dimensions or filename.

The file picker accepts PNG/JPEG/WebP only as a hint, but ASSET-002 content validation remains authoritative.

One import action may process one file in v0.3. Batch import is optional and must not complicate error recovery.

## Import feedback

During import expose clear states:

~~~text
reading
validating
hashing
storing
ready
error
~~~

The UI does not need to expose every internal phase as a separate progress bar, but the operation must not appear frozen while hashing/decoding a large allowed file.

On success:

- add/reuse the local asset in My assets;
- make it selectable immediately;
- if the same bytes/category already exist, focus/select the existing card and explain that the duplicate was reused.

On failure, keep the previous Story/library state intact and show an actionable error.

## Initial labels

Default the display label from the original filename without its extension.

Example:

~~~text
IMG_0421.webp
→
IMG_0421
~~~

Do not use the filename as identity.

## Rename

A local asset can be renamed from its card/action menu.

Rename:

- edits browser-local metadata only;
- does not rewrite Story/YAML;
- does not change hash/ref;
- does not affect other scenes using the same ref;
- may use a label already used by another asset.

Reject an empty/whitespace-only label.

Reasonable UI length limits are allowed, but they must not affect the stable reference.

## Delete

Deletion is allowed.

### Unused by current Story

Ask for normal destructive confirmation.

### Used by current Story

Show a stronger warning containing the number of current scenes that reference it.

Conceptually:

> This local asset is used by 3 scenes. Deleting it will leave those scenes with a missing local asset and MP4 rendering will be blocked until the reference is resolved or replaced.

Actions:

- Cancel
- Delete asset anyway

Do not silently rewrite the affected scenes.

The application cannot know whether exported YAML files outside the browser also reference this hash, so the confirmation should also avoid implying that only the current Story may be affected.

## Applying a local asset

Clicking a local pose/background card updates the selected scene through the **same visual draft/validation/browser-policy commit path** used by bundled assets.

Do not create a second custom-asset Story state.

The resulting Story stores the stable ref from ASSET-001.

## Missing reference UX

When the selected/current Story refers to a local asset absent from the current browser:

- show a clearly distinct **Missing local asset** card/placeholder;
- display category;
- display enough of the stable reference to identify it safely;
- identify affected scene(s);
- never render the previous asset as if the reference resolved.

Offer at least:

- **Import matching file**
- **Choose replacement**

### Import matching file

The user selects a local image.

If its SHA-256 + category produces the exact missing ref:

- durable library entry is created/reused;
- every scene referencing that ref resolves automatically;
- no Story mutation is required.

If the selected file hashes to a different ref:

- do not pretend it repaired the original;
- explain the mismatch;
- offer to use it as a replacement instead.

### Choose replacement

Selecting another bundled/local asset intentionally changes the affected scene reference through normal editor state.

If several scenes share the missing ref, v0.3 may replace only the selected scene by default. Bulk replacement is optional.

## Preview placeholders

A Story with unresolved local assets may still remain Active.

The Player area must not show a stale prior image.

Use an explicit placeholder appropriate to the category, for example:

~~~text
Missing local pose
local:pose:sha256:abcd…7890
~~~

or:

~~~text
Missing local background
local:background:sha256:abcd…7890
~~~

ASSET-004 defines renderer behavior and MP4 blocking.

## Local-only disclosure

Near My assets include concise product copy equivalent to:

> Stored only in this browser. These assets are not uploaded or synchronized.

Do not claim permanence: browser/site data may be cleared or evicted.

## Storage errors

If browser storage is unavailable/full:

- import fails without changing the selected scene;
- bundled assets remain usable;
- existing in-memory/available local assets remain usable when possible;
- show the storage error;
- do not silently convert the import into an ephemeral session-only asset in v0.3.

An asset selected for a Story must have a durable library entry first.

## Render-time mutation guard

While a browser MP4 render is in flight, local asset mutations that could invalidate the render snapshot must be disabled:

- import;
- rename;
- delete;
- applying another pose/background.

This follows the v0.2 invariant that authoring cannot change while an MP4 result is being produced.

## Accessibility

- local/bundled origin must not rely only on color;
- action buttons have accessible names;
- selected cards use `aria-pressed` or equivalent;
- missing-asset status is exposed to assistive technology;
- destructive confirmation identifies the asset by label and category.

## Tests

Minimum browser-level coverage:

- My assets section is separate from Bundled;
- import pose and import background create category-correct entries;
- supported asset becomes visible/selectable immediately;
- duplicate import reuses/focuses existing entry;
- applying local pose/background commits the stable ref to the Story;
- rename changes label but not Story ref;
- delete unused asset requires confirmation;
- delete-in-use warns with affected current-scene count;
- confirmed delete leaves exact Story refs intact and creates missing state;
- Cancel delete preserves asset and Story;
- exact-file re-import repairs missing ref without Story mutation;
- different-file import cannot masquerade as matching repair;
- choose replacement intentionally changes the selected scene ref;
- storage failure does not commit imported ref;
- asset mutation controls are disabled during browser render;
- local-only disclosure is visible.

## Acceptance criteria

- first-time user can understand which assets ship with Tora and which are local;
- import/use/rename/delete requires no YAML editing;
- labels and identity are clearly separated;
- delete-in-use is possible but never silent;
- missing refs are actionable;
- local-only behavior is explained in-product.

## Out of scope

- batch asset management;
- folders/tags/search;
- drag-and-drop reordering of asset library;
- cloud sync;
- sharing library entries;
- global replacement across arbitrary exported Stories.

## Done when

A user can manage a reusable My assets library from the browser UI while bundled Tora assets remain a distinct, immutable catalog.
