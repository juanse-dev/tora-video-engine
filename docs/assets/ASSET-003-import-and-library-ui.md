# ASSET-003 — My assets UI: import, rename, delete and recovery

> Status: **Proposed**
>
> Depends on: ASSET-002, ASSET-004. Read [README](./README.md) first (`INV-n`, constants, `D-n`).

## Goal

Extend the visual editor's asset catalog so a user can import, apply, rename and delete their own pose/background images, and recover a scene whose local asset is missing, without editing YAML. Bundled assets stay a separate, unchanged catalog.

## Decisions specific to this spec

- **Import applies.** A successful **Import pose** / **Import background** also applies the new ref to the selected scene through the normal `onChange` path (same as clicking a card). A failed import changes nothing.
- **Current selection card.** When the selected scene uses a local ref, the My assets section always shows that ref as the first card ("Current"), even if it is not on the visible page. This is also where a missing ref is shown and repaired. Pages are ordered by hash (D-11), so this card is how the user finds what they just imported.
- **Choose replacement** is not a separate flow: clicking any bundled or local card replaces the selected scene's ref, as today. The missing card says so.
- **Dialogs** reuse the existing `.transition-panel` + `role="dialog"` pattern from `src/web/App.tsx`. No native `confirm()`.
- **Render lock comes for free.** The editors are inside `<fieldset className="authoring-fieldset" disabled={authoringLocked}>` (`src/web/App.tsx`); all new buttons and file inputs live inside it, so they are disabled while an MP4 renders. Do not add a second lock mechanism.
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
| modify | `src/web/components/AssetCatalog.tsx` | Split each image category into **Bundled** and **My assets**. |
| modify | `src/web/App.tsx` | Provide `AssetLibraryContext`. |
| modify | `src/web/styles.css` | Styles for the new elements (reuse `.asset-card`, `.asset-grid`, `.transition-panel`). |
| create | `tests/local-asset-ui.test.mjs`, `tests/browser/my-assets.spec.mjs` | Tests. |

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
};

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
): {
  entries: Array<LocalAssetEntry & {thumbnailUrl: string | null}>;
  total: number;
  hasPrevious: boolean;
  hasNext: boolean;
  next(): void;
  previous(): void;
  loading: boolean;
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
- Local cards are `<button aria-pressed>` like bundled cards; clicking applies `onChange({pose: ref})` / `onChange({background: ref})`.
- Card thumbnails come only from `thumbnails` (ASSET-002). A card whose thumbnail is missing shows a neutral box with the label; it never loads the original blob.
- Corrupt rows (decoded `corrupt`) render as "Damaged entry" cards: not selectable; only Delete is offered.
- Rename: a `Rename` button turns the label into a text input with `Save` / `Cancel`; validation from `normalizeLocalAssetLabel`; Enter saves, Escape cancels. `not-found` result → message "This asset was deleted in another tab." and refresh.
- Delete: a `Delete` button opens a dialog with the right confirmation text and buttons `Cancel` / `Delete asset` (in use: `Delete asset anyway`). The Story is never modified.

### Import

- `Import pose` / `Import background` are `<label>` buttons wrapping a hidden `<input type="file" accept="image/png,image/jpeg,image/webp">` (accept is only a hint).
- While importing, show the current phase (`Reading…`, `Checking…`, `Hashing…`, `Saving…`) in a `role="status"` line and disable both import buttons.
- Success: apply the ref to the selected scene; show `Imported "${label}".` or, if `created` is false, `"${label}" was already in My assets; its stored copy was refreshed.`; bump `refreshToken`.
- Failure: show the `LocalAssetImportError` message (`describeImageRejection` or storage message) in a `role="alert"` line; nothing else changes.

### Missing / corrupt / unavailable current selection

When the selected scene's pose (or background) is a local ref whose state in `localAssetState` is not `ready`:

- the Current card is a `MissingLocalAssetCard` (`data-missing-local-asset-card={ref}`, `role="group"`, with the missing copy above);
- action **Import matching file** (file input for that category). After `prepareLocalAssetImport`:
  - `match` → commit the import (repairs/restores; no Story change because the ref is identical); readiness refreshes and every scene using that ref resolves;
  - `different` → dialog: `This file is a different image (${shortAssetId(candidateRef)}), so it can't restore the missing one.` with `Use it as replacement for this scene` (commit + apply to the selected scene only) and `Cancel` (nothing written);
- the bundled grid and My assets grid stay usable for choosing a replacement.

With library `disabled` / `unavailable`: no import, rename or delete controls; the disabled message is shown in each My assets block; the Current card still explains the ref is unavailable here.

### Story lifecycle never clears the library

Reset project, YAML import/apply, editor mode switches, and Story deletion of scenes never delete assets. Only the Delete action does.

## Tasks

- [ ] **1. Pure helpers + context.** `localAssetUi.ts`, `assetLibraryContext.ts`, App provides the context. `tests/local-asset-ui.test.mjs`.
- [ ] **2. Catalog split + paging + cards.** `useLocalAssetPage.ts`, `MyAssetsSection.tsx`, `LocalAssetCard.tsx`, `AssetCatalog.tsx`, styles.
- [ ] **3. Import, rename, delete flows.**
- [ ] **4. Missing/corrupt recovery card.** `MissingLocalAssetCard.tsx`.
- [ ] **5. Browser tests.** `tests/browser/my-assets.spec.mjs`.

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
- delete unused asset → confirmation → card gone;
- delete in-use asset → dialog shows the scene count; Cancel keeps everything; confirm → Story ref unchanged, missing card + Player placeholder, render blocked;
- Import matching file with the exact fixture → resolves with no Story change; with a different fixture → mismatch dialog; Cancel writes nothing; "Use it as replacement" changes only the selected scene;
- 120 seeded pose rows: first page shows 50 cards, count shows 120, Next/Previous work, and (instrumented init script) no `blobs` reads and no `getAll` on `assets`;
- during an MP4 render, import/rename/delete/select controls are disabled (fieldset);
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
