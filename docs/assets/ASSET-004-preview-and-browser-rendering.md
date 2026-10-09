# ASSET-004 — Preview and browser rendering with local assets

> Status: **Proposed**
>
> Depends on: ASSET-001, ASSET-002. Read [README](./README.md) first (`INV-n`, constants, `D-n`).

## Goal

Make the Player and the browser MP4 export draw local images for the Active Story, using `blob:` URLs (D-1) built from integrity-verified bytes. Missing or corrupt refs show placeholders in preview and block MP4. A Story over the aggregate budget does not mount the Player at all. Render preparation is race-safe against other tabs deleting assets.

No asset-management UI here (ASSET-003). Tests seed the library directly.

## Decisions specific to this spec

- One orchestration function computes the Story's local-asset state for both preview and render. Render uses it with stricter rules.
- The Player stays mounted while assets resolve; unresolved positions show the `pending` placeholder from ASSET-001. The Player is replaced by a message only when the Story is over budget.
- Render lock order is fixed: global `WEB_RENDER_LOCK_NAME` first, then `ASSET_LIBRARY_LOCK` in **shared** mode for a short final check. Mutations only take `ASSET_LIBRARY_LOCK` (exclusive) and never the render lock, so there is no lock cycle.

## Files

| Action | Path | Purpose |
| --- | --- | --- |
| create | `src/web/localAssetState.ts` | `resolveStoryLocalAssets()` orchestration + state types + messages. |
| create | `src/web/objectUrlPool.ts` | Ref-counted `digest → blob:` URL pool. |
| create | `src/web/useStoryLocalAssets.ts` | React hook: runs resolution per Story generation, owns pool leases. |
| modify | `src/web/components/Preview.tsx` | Accepts `localAssetState`; passes `localAssetSources` to the Player; over-budget/disabled messages. |
| modify | `src/web/browserRender.ts` | `renderStoryMediaOnWeb` and `startBrowserRenderTransaction` accept local sources and a post-lock preparation hook. |
| modify | `src/web/App.tsx` | Opens the library (`openAssetLibrary`), owns `IntegrityCache` + channel, wires state into Preview and render eligibility. |
| create | `tests/local-asset-state.test.mjs`, `tests/object-url-pool.test.mjs`, extend `tests/web-browser-render.test.mjs` | Unit tests. |
| create | `tests/browser/helpers/seedAssetLibrary.mjs` | Writes fixture records straight into IndexedDB from `page.evaluate` (using the v1 layout in ASSET-002), so tests can run before ASSET-003 exists. |
| create | `tests/browser/local-asset-preview.spec.mjs`, `tests/browser/local-asset-render-race.spec.mjs` | Browser tests on the production build. |
| modify | `tests/browser/browser-render-golden.spec.mjs` | Add the custom-asset MP4 golden. |

## Interfaces

### `src/web/localAssetState.ts`

~~~ts
export type LocalAssetRefState = {
  usage: LocalAssetUsage; // from ASSET-001 (ref, category, digest, sceneIndexes)
  status: "ready" | "missing" | "corrupt" | "unavailable";
  detail: string | null; // diagnostic text, e.g. "hash mismatch"
};

export type StoryLocalAssetState =
  | {kind: "none"} // Story has no local refs
  | {kind: "pending"; usages: LocalAssetUsage[]}
  | {kind: "over-budget"; usages: LocalAssetUsage[]; budget: Extract<LocalAssetBudgetResult, {ok: false}>; message: string}
  | {
      kind: "resolved";
      refs: LocalAssetRefState[];
      verified: ReadonlyMap<string, VerifiedPayload>; // digest → payload, only for ready digests
      blobs: ReadonlyMap<string, Blob>;               // digest → blob, only for ready digests
      allReady: boolean;
    };

export const resolveStoryLocalAssets = async (
  story: Story,
  library: AssetLibraryStatus,
  cache: IntegrityCache,
  deps?: {subtle?: SubtleCrypto},
): Promise<Exclude<StoryLocalAssetState, {kind: "pending"}>>;

/**
 * Builds the post-lock step for startBrowserRenderTransaction (see "Render start sequence").
 * Pure apart from its injected dependencies, so it is unit-testable with fakes.
 */
export const createLocalAssetRenderPreparation = (input: {
  resolved: Extract<StoryLocalAssetState, {kind: "resolved"}>; // must have allReady
  store: AssetLibraryStore;
  locks: LockManager;
  pool: ObjectUrlPool;
}): (() => Promise<LocalAssetRenderPreparation>);

/** Message for the render button area, or null when local assets allow rendering. */
export const describeLocalAssetRenderBlock = (
  state: StoryLocalAssetState,
  library: AssetLibraryStatus,
): string | null;
~~~

`resolveStoryLocalAssets` algorithm (each step only proceeds with what the previous step accepted):

1. `usages = collectStoryLocalAssetUsages(story)`. Empty → `{kind: "none"}`.
2. If `library.kind !== "ready"` → `resolved` with every ref `unavailable` (`detail` = library message), `allReady: false`. No store reads.
3. For each usage, `store.getAssetRow(usage.ref)` — the ref itself is the key (INV-11): `absent` → `missing`; `corrupt` → `corrupt`; `present` → candidate.
4. For each distinct digest with at least one candidate ref, `store.getPayloadMeta(digest)`: `absent` → its candidate refs become `missing`; `corrupt` → `corrupt`; `present` → record metadata.
5. `budget = evaluateLocalAssetBudget(usages, metadataByDigest)`. If not ok → `over-budget` with `describeBudgetFailure(budget)`. **No blob has been read at this point** (D-10).
6. `verifyPayloadsSequentially(store, digestsWithMetadata, cache)`. Failures mark every ref with that digest `missing`/`corrupt`. Other digests continue.
7. Return `resolved` with `verified` and `blobs` for successful digests; `allReady` is true only if every ref is `ready`.

`describeLocalAssetRenderBlock` returns, in priority order:

- library `disabled`/`unavailable` and the Story has local refs → the library message;
- `pending` → `"Checking local assets…"`;
- `over-budget` → the budget message;
- any non-ready ref → `"Browser render is blocked because N local asset(s) are unavailable in this browser."` (N = number of non-ready distinct refs);
- otherwise `null`.

### `src/web/objectUrlPool.ts`

~~~ts
export class ObjectUrlPool {
  constructor(deps?: {create?: (blob: Blob) => string; revoke?: (url: string) => void});
  /** Returns the existing URL for digest or creates one; increments its holder count. */
  acquire(digest: string, blob: Blob): string;
  /** Decrements; revokes the URL when the count reaches 0. */
  release(digest: string): void;
  /** Revokes everything (app teardown). */
  dispose(): void;
}
~~~

A "lease" is a set of digests acquired together (one for the current preview state, one per in-flight render). Repeated scene refs to one digest share one URL.

### `src/web/useStoryLocalAssets.ts`

~~~ts
export const useStoryLocalAssets = (
  story: Story,
  library: AssetLibraryStatus,
  cache: IntegrityCache,
  pool: ObjectUrlPool,
  refreshToken: number, // bumped on asset-library-changed messages and window focus
): {state: StoryLocalAssetState; sources: LocalAssetSourceMap | undefined};
~~~

- `library` must be referentially stable: App keeps the `AssetLibraryStatus` in `useState`, set when `openAssetLibrary` settles (and again only if the library later becomes unavailable). Never build it inline. The effect depends on `[story, library, refreshToken]`, where `story` is the Active Story object (its identity changes only when the Story changes).
- Each `(story, library, refreshToken)` change starts a new generation. Results from older generations are ignored (and their leases released) — this guarantees a slow resolution for ref A cannot overwrite the result for ref C.
- While a generation runs, return `state: {kind: "pending"}` and a source map that keeps the previous generation's URLs for refs that are still in the Story and maps every other local ref to `{kind: "pending"}`.
- On `resolved`, acquire pool URLs for every ready digest and build `{[ref]: {kind: "url", url}}` for ready refs only (missing/corrupt refs have no entry → placeholder).
- Release the previous lease in a `useEffect` cleanup **after** the new sources are committed, so the Player never sees a revoked URL.
- `none` → `sources: undefined`.

### `src/web/components/Preview.tsx`

~~~ts
type PreviewProps = {
  story?: Story;
  localAssetSources?: LocalAssetSourceMap;
  localAssetState?: StoryLocalAssetState;
};
~~~

- Pass `inputProps={{story, localAssetSources}}` to the Player.
- If `localAssetState.kind === "over-budget"`, render a message box (`role="status"`, `data-local-asset-over-budget`) with the budget message instead of the Player.
- If any ref is non-ready, show a short status line under the Player (`data-local-asset-status`), e.g. `"2 local assets are missing in this browser. Scenes 1, 3 show placeholders."`.

### Browser render changes (`src/web/browserRender.ts`)

~~~ts
export const renderStoryMediaOnWeb = async (
  story: Story,
  options: {
    // …existing options…
    localAssetSources?: LocalAssetSourceMap;
    component?: ComponentType<ToraVideoProps>;
  },
) => …; // passes {story, localAssetSources} as both defaultProps and inputProps

export type LocalAssetRenderPreparation =
  | {ok: true; localAssetSources: LocalAssetSourceMap | undefined; release: () => void}
  | {ok: false; message: string};

// new optional option of startBrowserRenderTransaction:
prepareLocalAssets?: () => Promise<LocalAssetRenderPreparation>;
~~~

`startBrowserRenderTransaction` calls `prepareLocalAssets` **immediately after the render lock lease is acquired and before the pre-render OPFS cleanup**. On `{ok: false}` it releases the lease and returns a new outcome `{kind: "assets-changed", message}` without touching OPFS. On success it passes `localAssetSources` to `renderStory` and calls `release()` after the post-render cleanup (whatever the outcome, including cancel and cleanup-blocked).

## Render start sequence (App)

When the user clicks **Render MP4** and the Story contains local refs:

1. Button is enabled only when existing v0.2 conditions hold **and** `describeLocalAssetRenderBlock(state, library) === null`.
2. Snapshot the Active Story and enter the existing `rendering` phase exactly as `startBrowserRender` in `src/web/App.tsx` does today (`renderInFlightRef`, `AbortController`, `setRenderUi({phase: "rendering", …})`). From this point `authoringLocked` is true, so the Story and every asset control are frozen for the **whole** preparation, not only the encode. Use the message `"Checking local assets…"` while step 3 runs.
3. Heavy step, no locks held: `resolveStoryLocalAssets(snapshot, library, cache)`. Check `controller.signal.aborted` between digests (Cancel Render works during preparation). If not `resolved` with `allReady`, or cancelled → leave the rendering phase through the existing failure/cancel paths (which unlock authoring) and show the block message.
4. Call `startBrowserRenderTransaction(snapshot, {…, prepareLocalAssets: createLocalAssetRenderPreparation({resolved, store, locks, pool})})`. The returned function:
   1. runs inside `withAssetLibraryLock(locks, "shared", …)`;
   2. for every usage: `getAssetRow(ref)` must still be `present`, and `getPayloadMeta(digest)` must still be `present` and equal (mimeType, byteSize, width, height) to the payload verified in step 3. Re-checking the **row per ref** matters: deleting `local:pose:sha256:A` must be caught even if `local:background:sha256:A` keeps the bytes alive;
   3. if anything changed → `{ok: false, message: "Local assets changed while preparing the render. Try again."}`;
   4. otherwise acquire pool URLs from the blobs obtained in step 3 (one lease for this render), build the map, `Object.freeze` it, and return `{ok: true, localAssetSources, release}`;
   5. the shared lock is released when the callback returns.
5. During render the existing authoring lock keeps the Story and the asset UI read-only (ASSET-003 adds the asset controls to that lock).
6. After settlement, `release()` the render lease and bump `refreshToken` so preview readiness reflects any deletion that happened during the render.

Stories without local refs skip steps 3–4's asset work (`prepareLocalAssets` returns `{ok: true, localAssetSources: undefined, release: () => {}}`).

The render lock keeps its existing non-blocking acquisition (`ifAvailable: true`): if another tab is rendering, the transaction returns `busy` immediately, as in v0.2. Do not change that into a queue.

Why this is race-safe: a mutation that commits between step 3 and the moment the render lock is granted is seen by step 4.2. A mutation requested during step 4 waits for the shared lock. A mutation after step 4 changes IndexedDB but not the frozen map or the `Blob` objects the render already holds.

## Tasks

- [ ] **1. Orchestration.** `localAssetState.ts` (`resolveStoryLocalAssets`, `createLocalAssetRenderPreparation`, `describeLocalAssetRenderBlock`) + `tests/local-asset-state.test.mjs` (uses `tests/helpers/memoryAssetStore.mjs`).
- [ ] **2. URL pool and hook.** `objectUrlPool.ts`, `useStoryLocalAssets.ts`, `tests/object-url-pool.test.mjs`.
- [ ] **3. Preview wiring.** `Preview.tsx`, `App.tsx` (open library on mount, channel + focus → `refreshToken`, cache invalidation on messages), `tests/browser/helpers/seedAssetLibrary.mjs`, `tests/browser/local-asset-preview.spec.mjs`.
- [ ] **4. Render wiring.** `browserRender.ts`, `App.tsx` render sequence, extend `tests/web-browser-render.test.mjs`, `tests/browser/local-asset-render-race.spec.mjs`.
- [ ] **5. MP4 golden.** Extend `tests/browser/browser-render-golden.spec.mjs` with a Story using `pose-magenta.png` and `background-cyan.jpg` (seeded), render, and sample frames: magenta present in the pose area, cyan in the top half / yellow in the bottom half of the background, plus a bundled-only positive control. Check H.264, video-only, 1080×1920, 30 FPS, expected frame count.

## Tests

`tests/local-asset-state.test.mjs`

- bundled-only Story → `none`, zero store reads;
- library `disabled` → every ref `unavailable`, zero store reads;
- all refs present and valid → `allReady`, one blob read per distinct digest even when 5 scenes share it;
- mixed: valid A + missing B → A ready (in `verified`), B missing, `allReady: false`;
- mixed: valid A + corrupt C (blob bytes of another image) → A ready, C corrupt;
- row present but payloadMeta absent → `missing`; row value claiming another digest → `corrupt` and zero reads of that other digest;
- pose row for digest D deleted but background row for D present → pose ref `missing`, background ref ready;
- over budget by refs (65 refs, all missing metadata) → `over-budget`, zero blob reads;
- over budget by bytes and by pixels (fake metadata) → `over-budget`, zero blob reads; exactly at limits → proceeds;
- `describeLocalAssetRenderBlock` returns each message in the priority order above;
- `createLocalAssetRenderPreparation`: unchanged library → `ok` with a frozen map containing one `url` entry per ready ref; pose row deleted after resolution (background row for the same digest kept) → `ok: false`; payloadMeta changed after resolution → `ok: false`; the asset lock is requested in `shared` mode (fake `LockManager`).

`tests/object-url-pool.test.mjs`

- same digest acquired twice → one `create`, revoked only after two releases;
- `dispose` revokes all; releasing an unknown digest is a no-op.

`tests/web-browser-render.test.mjs` (extend)

- `renderStoryMediaOnWeb` passes `localAssetSources` in both `defaultProps` and `inputProps`;
- `prepareLocalAssets` runs after `acquireLock` and before the first `cleanup` call (record call order);
- `{ok: false}` → outcome `assets-changed`, lease released, `cleanup` and `renderStory` never called;
- `release()` is called after post-cleanup on success, failure and cancel;
- (browser, `local-asset-preview.spec.mjs`) while a Story with local refs is in the "Checking local assets…" preparation step, the authoring fieldset is disabled, and Cancel Render returns to the editable state without creating OPFS entries;
- with a fake `LockManager` that records events, the order is: render lock granted → asset lock requested in `shared` mode → rows re-read → map frozen → asset lock released → `renderStory` called; the asset lock is never requested before the render lock. (That an exclusive request waits for a held shared lock is Web Locks behavior, already covered by the ASSET-002 harness test.)

`tests/browser/local-asset-preview.spec.mjs` (production build, seeded IndexedDB, Story loaded through the YAML editor)

- local pose + background render inside the Player (no placeholder elements; images have `blob:` sources);
- the Player does not advance past frame 0 while a local image is still loading: `page.route` cannot intercept `blob:` URLs, so add an init script that overrides the `HTMLImageElement.prototype` `src` setter: values starting with `blob:` are queued and only applied after the test calls `window.__releaseBlobImages()`. Press play, assert `data-tora-frame` stays `0` while queued, release, then assert frames advance (same assertion style as `tests/browser/player-readiness.spec.mjs`);
- deleting the seeded background record (raw IndexedDB) and reloading → `[data-missing-local-asset]` only for the background, pose still an image, render button disabled with the "unavailable" message;
- seeding a corrupt blob (bytes of the other fixture) → placeholder for that ref only;
- a Story with 65 distinct local refs (seed metadata only, no blobs) → over-budget message, no Player, and no reads from the `blobs` store (wrap `IDBObjectStore.prototype.get` in an init script to log store names);
- changing the pose ref rapidly A → B → C through the YAML editor ends with C displayed;
- `page.addInitScript` deleting `navigator.locks` → library disabled message; bundled reference Story still previews normally.

`tests/browser/local-asset-render-race.spec.mjs` (two pages, one context)

- page B holds `tora-video-engine:web-fs-render` (via `navigator.locks.request` in `page.evaluate`); page A clicks Render and gets the existing v0.2 `busy` message; page B deletes the required pose row and releases the render lock; page A clicks Render again and is blocked by the missing-asset message (fresh step 3), with no `__remotion_render:` OPFS entry created. The "changed between verification and lock" window itself is covered deterministically by the `createLocalAssetRenderPreparation` unit tests (row deleted after resolution → `ok: false`) and the `startBrowserRenderTransaction` ordering test, not by browser timing;
- page B deletes the pose row **after** page A's render has started (progress visible) → A's render still succeeds and its MP4 contains the pose;
- after A's render completes, B's earlier deletion shows as missing in A without reload (refresh token).

## Verify

~~~bash
npm test
npm run lint
npm run web:build
npm run test:browser
npm run test:harness
npx playwright test --config=playwright.browser-render.config.mjs
~~~

## Out of scope

Import/rename/delete UI and the missing-asset recovery UX (ASSET-003); CLI (ASSET-005); audio; remote URLs; transcoding.

## Done when

All tasks are ticked: the Player shows local images, explicit placeholders for missing/corrupt refs, and an over-budget message without reading blobs; browser MP4 renders seeded local images (golden passes); render preparation detects concurrent deletions; and bundled-only behavior and output are unchanged.
