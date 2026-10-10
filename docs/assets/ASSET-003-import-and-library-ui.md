# ASSET-003 — My assets UI: import, rename, delete and recovery

> Status: **Implemented**. The visual editor's asset catalog splits into Bundled and My assets; users import, apply, rename and delete local images and recover a missing or damaged one from the Current selection card; verified by `npm test`, `tests/browser/my-assets.spec.mjs` and, under system Chrome, `tests/browser/my-assets-render.spec.mjs`.
>
> Depends on: ASSET-002, ASSET-004. Read [README](./README.md) first (`INV-n`, constants, `D-n`).

## Goal

Extend the visual editor's asset catalog so a user can import, apply, rename and delete their own pose/background images, and recover a scene whose local asset is missing, without editing YAML. Bundled assets stay a separate, unchanged catalog.

## Decisions specific to this spec

- **Import applies.** A successful **Import pose** / **Import background** also applies the new ref to the selected scene through the normal `onChange` path (same as clicking a card). A failed import changes nothing.
- **Current selection card.** When the selected scene uses a local ref, the My assets section always shows that ref as the first card ("Current"), even if it is not on the visible page. This is also where a missing ref is shown and repaired. Pages are ordered by hash (D-11), so this card is how the user finds what they just imported.
- **Choose replacement** is not a separate flow: clicking any bundled or local card replaces the selected scene's ref, as today. The missing card says so.
- **Dialogs** (delete confirmation, matching-file mismatch) reuse the existing `.transition-panel` + `role="dialog"` pattern and are rendered by App **next to `renderTransitionPanel()`, outside the authoring fieldset**, through `openAssetDialog` in the context. No native `confirm()`. Only one dialog of any kind is open at a time: an asset dialog cannot open while an App transition panel is open, and vice versa.
- **Render lock comes for free.** The editors are inside `<fieldset className="authoring-fieldset" disabled={authoringLocked}>` (`src/web/App.tsx`); all new buttons and file inputs live inside it, so they are disabled while an MP4 renders. Do not add a second lock mechanism.
- **Imports lock authoring too.** `VisualEditor` binds the catalog's `onChange` to the numeric `selectedScene` index, so the Story structure must not change while an import is reading/hashing/saving. App gets an `assetImportInFlight` state (set through the context, see below). Rename the current expression to `renderAuthoringLocked` and define `authoringLocked = renderAuthoringLocked || assetImportInFlight || assetDialog !== null` (an open asset dialog also freezes the Story, so the delete warning's scene count cannot go stale before confirmation); every existing use of `authoringLocked` (the fieldset, Open YAML/visual, YAML import, Reset, Render) then also locks during an import. Keep `renderAuthoringLocked` for render-only logic such as `renderNeedsUnloadWarning`. Because nothing can move, delete or reselect scenes meanwhile, the import result is applied to the same `selectedScene` it started from.
  - Import buttons (including Import matching file) are disabled while an App transition panel (`transition !== null`) or any asset dialog is open, so an import can never start under a pending Reset/mode transition.
  - Defensively, the confirmation buttons of App transition panels are disabled while `assetImportInFlight` is true.
  - The mismatch dialog is part of the import: `assetImportInFlight` stays true until the user picks **Use it as replacement** or **Cancel**. Its buttons stay enabled because the dialog is rendered outside the disabled fieldset; every other authoring control stays locked until the choice is made.
  - The delete dialog's confirm button is disabled while `renderAuthoringLocked || assetImportInFlight` is true (not `authoringLocked`, which the dialog itself sets). Its `sceneCount` is computed when the dialog opens and stays valid because the Story is frozen while it is open.
- The library handle is shared through a React context so `VisualEditor` does not need new props.

## Files

| Action | Path | Purpose |
| --- | --- | --- |
| create | `src/web/assetLibraryContext.ts` | `AssetLibraryContext` value type + `createContext` (no JSX in this file). |
| create | `src/web/useLocalAssetPage.ts` | Paging state per category + thumbnail object URLs for the visible page. |
| create | `src/web/localAssetUi.ts` | Pure helpers: scene counts, copy text, matching-file evaluation. |
| create | `src/web/components/MyAssetsSection.tsx` | One category's My assets block. |
| create | `src/web/components/LocalAssetCard.tsx` | Card: thumbnail, label, origin badge, select, rename, delete. |
| create | `src/web/components/MissingLocalAssetCard.tsx` | Missing/corrupt/unavailable current-selection card with repair actions. |
| create | `src/web/localAssetPageController.ts` | Framework-free paging core behind `useLocalAssetPage` (R10). |
| create | `src/web/localAssetImportFlow.ts`, `src/web/useLocalAssetImport.ts` | Import / Import matching file pipeline and its hook (one pipeline, phases, in-flight lock). |
| create | `src/web/localAssetManageFlow.ts`, `src/web/useLocalAssetManage.ts` | Rename and delete flows and their hook. |
| create | `src/web/components/AssetDialogHost.tsx` | Renders the open asset dialog outside the fieldset (R8). |
| modify | `src/web/components/AssetCatalog.tsx` | Split each image category into **Bundled** and **My assets**. |
| modify | `src/web/App.tsx` | Provide `AssetLibraryContext`. |
| modify | `src/web/styles.css` | Styles for the new elements (reuse `.asset-card`, `.asset-grid`, `.transition-panel`). |
| create | `tests/local-asset-ui.test.mjs`, `tests/local-asset-page.test.mjs`, `tests/local-asset-flows.test.mjs`, `tests/browser/my-assets.spec.mjs`, `tests/browser/my-assets-render.spec.mjs` | Tests. |

## Interfaces

### `src/web/assetLibraryContext.ts`

~~~ts
export type AssetLibraryContextValue = {
  status: AssetLibraryStatus;           // ASSET-002
  locks: LockManager | undefined;
  channel: {post(m: AssetLibraryMessage): void};
  refreshToken: number;                 // ASSET-004; bump to refetch pages
  bumpRefresh: () => void;
  activeStory: Story;                   // for delete-in-use counts
  localAssetState: StoryLocalAssetState; // ASSET-004; per-ref readiness
  setAssetImportInFlight: (inFlight: boolean) => void; // locks authoring during imports
  transitionPending: boolean;                          // App transition panel open → imports disabled
  openAssetDialog: (dialog: AssetDialog) => boolean;   // rendered by App outside the fieldset; false = not opened (a transition panel or another asset dialog is open)
  closeAssetDialog: () => void;                        // closes without running callbacks; for a mismatch dialog it also releases the import lock
};

export type AssetDialog =
  | {kind: "delete"; ref: LocalAssetRef; label: string; category: LocalAssetCategory; sceneCount: number;
     onConfirm: () => Promise<void>}
  | {kind: "mismatch"; candidateRef: LocalAssetRef;
     onReplace: () => Promise<void>; onCancel: () => void};

export const AssetLibraryContext = createContext<AssetLibraryContextValue | null>(null);
~~~

### `src/web/localAssetUi.ts`

~~~ts
/** Number of scenes in the Active Story whose pose or background equals ref. */
export const countScenesUsingRef = (story: Story, ref: LocalAssetRef): number;

export type MatchingFileResult =
  | {kind: "match"}                               // same category + same digest
  | {kind: "different"; candidateRef: LocalAssetRef};

export const evaluateMatchingFile = (
  missingRef: LocalAssetRef,
  candidateRef: LocalAssetRef,
): MatchingFileResult;

export const deleteConfirmationText = (label: string, category: LocalAssetCategory, sceneCount: number): string;
export const localOnlyDisclosure = (origin: string): string;
~~~

Copy (exact strings, so tests can assert them):

- disclosure: `Stored only in this browser for ${origin}. Not uploaded or synced. Production, Deploy Previews and localhost each keep a separate library.`
- delete, unused: `Delete "${label}" (${category}) from My assets?`
- delete, in use: `"${label}" (${category}) is used by ${n} scene(s) in this Story. Deleting it leaves those scenes with a missing local asset, and MP4 rendering stays blocked until you re-import the same file or choose a replacement. Other exported YAML files may also use it.`
- missing card: `Missing local ${category}` + `shortAssetId(ref)` + `Used by scene(s) ${list}.` + `Import the original file to restore it, or pick any other ${category} to replace it.`
- corrupt card: same title as missing plus `The stored copy is damaged.`
- disabled library: the `AssetLibraryStatus` message.

### `useLocalAssetPage`

~~~ts
export const useLocalAssetPage = (
  category: LocalAssetCategory,
  pinnedRef: LocalAssetRef | null = null, // the scene's current ref, loaded even when off the page (R9, R10)
): {
  entries: Array<LocalAssetEntry & {thumbnailUrl: string | null}>;
  total: number;
  hasPrevious: boolean;
  hasNext: boolean;
  next(): void;
  previous(): void;
  loading: boolean;
  loaded: boolean;                 // a load has settled (no "empty" text before that)
  error: string | null;
  pinnedFor: LocalAssetRef | null; // the ref `pinned` describes
  pinned: PinnedLocalAsset;        // none | loading | missing | error | present (R12)
};
~~~

- Uses `listLocalAssetPage` / `countLocalAssets` (ASSET-002): one page of at most 50 rows and their thumbnails. Never reads `blobs`.
- Creates thumbnail object URLs for the visible page only; revokes them when the page changes or the component unmounts.
- Refetches the current page when `refreshToken` changes. If the page became empty (deletions), step back one page.

## UI behavior

### Layout (inside `AssetCatalog`, for poses and for backgrounds)

~~~text
Tora poses
  Bundled
    [Formal] [Confused] [Panic] [Coffee]
  My assets · 12            ← total count
    Stored only in this browser …
    [Current: My cat ✓] [+ Import pose]
    [Alpha] [Beta] … (≤ 50)  [‹ Previous] [Next ›]
~~~

- Section headings are text (`Bundled`, `My assets`), not color only. Local cards carry a visible `Local` badge.
- Bundled cards keep their current markup, class names and behavior.
- A local card is a **non-interactive wrapper** (`<div className="asset-card local-asset-card">`) containing, as siblings: one selection `<button type="button" aria-pressed>` (thumbnail + label + `Local` badge; clicking applies `onChange({pose: ref})` / `onChange({background: ref})`), and a separate actions row with `Rename` and `Delete` buttons. Never nest buttons or inputs inside the selection button. Management buttons do not trigger selection (they are not descendants of the selection button, so no click bubbles into it).
- Card thumbnails come only from `loadThumbnailForDisplay` (ASSET-002), which inspects the real thumbnail bytes before an object URL exists. A card whose thumbnail is missing or corrupt shows a neutral box with the label; it never loads the original blob.
- Corrupt rows (decoded `corrupt`) render as "Damaged entry" cards: not selectable; only Delete is offered.
- Rename: the `Rename` button replaces the selection button's label area with a sibling text input plus `Save` / `Cancel` buttons (the selection button is hidden while editing); validation from `normalizeLocalAssetLabel`; Enter saves, Escape cancels. `not-found` result → message "This asset was deleted in another tab." and refresh.
- Delete: a `Delete` button opens a dialog with the right confirmation text and buttons `Cancel` / `Delete asset` (in use: `Delete asset anyway`). The Story is never modified.

### Import

- `Import pose` / `Import background` are `<label>` buttons wrapping a hidden `<input type="file" accept="image/png,image/jpeg,image/webp">` (accept is only a hint).
- While importing (including Import matching file), call `setAssetImportInFlight(true)` before reading the file and `false` in a `finally` once the import ends: result applied, error shown, or — for a mismatch — after the user's dialog choice. Show the current phase (`Reading…`, `Checking…`, `Hashing…`, `Saving…`) in a `role="status"` line; text stays visible because a disabled fieldset only disables its controls.
- Success: apply the ref to the selected scene; show `Imported "${label}".` or, if `created` is false, `"${label}" was already in My assets; its stored copy was refreshed.`; bump `refreshToken`.
- Failure: show the `LocalAssetImportError` message (`describeImageRejection` or storage message) in a `role="alert"` line; nothing else changes.

### Missing / corrupt / unavailable current selection

When the selected scene's pose (or background) is a local ref whose state in `localAssetState` is not `ready`:

- the Current card is a `MissingLocalAssetCard` (`data-missing-local-asset-card={ref}`, `role="group"`, with the missing copy above);
- action **Import matching file** (file input for that category). Call `prepareLocalAssetImport` (nothing is written yet), then `evaluateMatchingFile(missingRef, prepared.ref)`:
  - `match` → `commitPreparedLocalAssetImport(prepared, …)` (repairs/restores; no Story change because the ref is identical); readiness refreshes and every scene using that ref resolves;
  - `different` → dialog: `This file is a different image (${shortAssetId(candidateRef)}), so it can't restore the missing one.` with `Use it as replacement for this scene` (`commitPreparedLocalAssetImport` + apply to the selected scene only) and `Cancel` (nothing written; drop the prepared bytes);
- the bundled grid and My assets grid stay usable for choosing a replacement.

With library `disabled` / `unavailable`: no import, rename or delete controls; the disabled message is shown in each My assets block; the Current card still explains the ref is unavailable here.

### Story lifecycle never clears the library

Reset project, YAML import/apply, editor mode switches, and Story deletion of scenes never delete assets. Only the Delete action does.

## Tasks

- [x] **1. Pure helpers + context.** `localAssetUi.ts`, `assetLibraryContext.ts`, App provides the context. `tests/local-asset-ui.test.mjs`.
- [x] **2. Catalog split + paging + cards.** `useLocalAssetPage.ts`, `MyAssetsSection.tsx`, `LocalAssetCard.tsx`, `AssetCatalog.tsx`, styles.
- [x] **3. Import, rename, delete flows.**
- [x] **4. Missing/corrupt recovery card.** `MissingLocalAssetCard.tsx`.
- [x] **5. Browser tests.** `tests/browser/my-assets.spec.mjs` and `tests/browser/my-assets-render.spec.mjs` (R6).

## Tests

`tests/local-asset-ui.test.mjs`

- `countScenesUsingRef` counts scenes (not fields) and ignores the other category's ref with the same digest;
- `evaluateMatchingFile`: same ref → `match`; same digest other category → `different`; other digest → `different`;
- every copy function returns the exact strings above (including singular/plural handling chosen in implementation).

`tests/browser/my-assets.spec.mjs` (production build, fixtures from `tests/fixtures/local-assets/`, `page.setInputFiles`)

- Bundled and My assets headings are both present for poses and backgrounds; bundled cards unchanged;
- disclosure text includes the page origin;
- import pose fixture → card appears as Current, scene pose becomes the local ref (check via YAML export or the YAML editor), Player shows the image;
- import background fixture via the **extensionless** file → accepted;
- import an APNG / a >25 MiB file / a GIF (generate in the test into a temp dir) → error message, Story unchanged, no new card;
- importing the same pose file again → "already in My assets" message, still one card;
- rename → label changes, Story YAML unchanged;
- clicking Rename or Delete does not change the selected scene's ref, and the card markup contains no nested interactive elements (no `button button`, `button input`);
- delete unused asset → confirmation → card gone;
- delete in-use asset → dialog shows the scene count; Cancel keeps everything; confirm → Story ref unchanged, missing card + Player placeholder, render blocked;
- Import matching file with the exact fixture → resolves with no Story change; with a different fixture → mismatch dialog; Cancel writes nothing; "Use it as replacement" changes only the selected scene;
- 120 seeded pose rows: first page shows 50 cards, count shows 120, Next/Previous work, and (instrumented init script) no `blobs` reads and no `getAll` on `assets`;
- during an MP4 render, import/rename/delete/select controls are disabled (fieldset);
- Import matching file with a different fixture while the digest is held: after release the mismatch dialog's buttons are enabled (outside the fieldset) while scene controls stay disabled; both **Use it as replacement** and **Cancel** unlock authoring afterwards;
- while a delete dialog is open, scene add/move/delete/select, Open YAML and Reset are disabled, and Cancel/confirm in the dialog work;
- with the Reset (or Open YAML) transition panel open, import buttons are disabled; with an import in flight, transition panel confirmation buttons are disabled;
- during an import (hold it with an init script that wraps `crypto.subtle.digest` in a promise released by `window.__releaseDigest()`), scene add/move/delete/select, Open YAML, Reset and Render are disabled; after release the imported ref lands on the scene that was selected when the import started;
- Reset project and YAML import leave My assets intact;
- with `navigator.locks` removed → disabled message, no import buttons, bundled flow works.

## Verify

~~~bash
npm test
npm run lint
npm run web:build
npm run test:browser
~~~

## Out of scope

Batch import, folders/tags/search, drag-and-drop, bulk replacement across scenes or exported Stories, clearing the whole library, sharing.

## Done when

All tasks are ticked and a user can import, apply, rename, delete and recover local assets from the visual editor, with bundled assets visibly separate and unchanged.

## Implementation notes

Rulings made while implementing (R1–R11):

- **R1:** each task wrote the browser tests for its own behaviour into `tests/browser/my-assets.spec.mjs` (RED before the implementation); task 5 added the cross-cutting ones. Browser behaviour cannot be TDD'd if every spec lands at the end.
- **R2:** App owns every `AssetLibraryContextValue` field from task 1 (import-in-flight, asset dialog, the `renderAuthoringLocked` / `authoringLocked` split), so later tasks only consume the context.
- **R3:** `context.status` is `assetLibrary ?? OPENING_ASSET_LIBRARY` (kind `unavailable`, "Checking local assets…"): the context type is non-null, and My assets shows that message with no controls until the library opens.
- **R4:** App owns one `BroadcastChannel` for its lifetime and `channel.post` also invalidates the integrity cache and bumps the refresh token locally. A `BroadcastChannel` never delivers to its sender, so without this a same-tab delete would leave the asset "ready" and renderable.
- **R5:** the phase line maps the ASSET-002 enum to the spec copy: `reading` → "Reading…", `validating` → "Checking…", `hashing` → "Hashing…", `storing` → "Saving…".
- **R6:** the test that needs an MP4 render lives in `tests/browser/my-assets-render.spec.mjs`, listed in `playwright.browser-render.config.mjs` (system Chrome, run in CI). Bundled Chromium cannot encode H.264, so there it would always skip.
- **R7:** browser tests that start Player playback mute the Player first ("Mute sound"), because playback hangs on the Linux runner (issue #24).
- **R8:** asset dialogs render through `AssetDialogHost` (`src/web/components/AssetDialogHost.tsx`) next to `renderTransitionPanel()`, outside the fieldset. The host owns busy state and error handling, closes only the dialog it opened, and `openAssetDialog` returns a boolean, so a rejected callback can never freeze authoring.
- **R9:** the Current card's ref is not repeated in the page grid (the page shows up to 50 others plus Current), because a duplicate selected card is confusing.
- **R10:** `useLocalAssetPage(category, pinnedRef = null)` takes the pinned ref and delegates to the pure `localAssetPageController.ts`, which R9 needs and which can be unit-tested in Node.
- **R11:** with a ready library, the Current card for any non-ready ref state (missing, corrupt or unavailable, for example a read failure) offers **Import matching file**; only a disabled or unavailable library hides actions, as the spec says.
- **R12:** one fix wave after the final review: the Current card shows a neutral placeholder for the selected ref while its pin loads (no flicker on scene switch), a failed pin load becomes an `error` state shown as unavailable (never stuck loading) and a pinned entry is only used for the ref it was loaded for; while the library is opening the Current card says "Checking local assets…" instead of "unavailable"; `closeAssetDialog` also releases the import lock of a mismatch dialog; import labels get a visible keyboard focus outline; paging glyphs are `aria-hidden`; no "No imported …s yet." text before the first load settles.
- **R13:** deferred to follow-ups: scene counts in the delete/missing copy use the Active Story, not the visual draft (the spec chose `activeStory`); no cancel for a stuck commit; a same-tab rename re-hashes (an ASSET-002 change); cancelling a browser render mid-encode ends in `cleanup-blocked` (pre-existing).
- Deferred: the cross-category re-entrancy of imports and the Safari/Firefox focus restore after a dialog closes have no browser coverage.
