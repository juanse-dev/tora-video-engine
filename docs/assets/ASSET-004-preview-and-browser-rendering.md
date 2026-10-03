# ASSET-004 — Preview and browser rendering integration

> Status: **Proposed**

## Goal

Render browser-local pose/background images through the same shared Remotion composition used by Player and browser MP4 export, using the runtime source transport already proven by ASSET-001 while keeping asset bytes/runtime sources outside Story data.

## Shared composition contract

The current `ToraVideoProps` carries only:

~~~ts
{
  story: Story;
}
~~~

v0.3 extends the runtime render props with an **ephemeral resolved local-source map**, conceptually:

~~~ts
type LocalAssetSourceMap =
  Readonly<Record<LocalVisualAssetRef, string>>;

type ToraVideoProps = {
  story: Story;
  localAssetSources?: LocalAssetSourceMap;
};
~~~

The exact name/shape may differ, but these invariants are required:

- Story remains unchanged;
- source-map values are runtime image URLs only;
- bundled refs do not need entries;
- old callers with only `story` continue to work;
- the map is never serialized into YAML or Story persistence.

Using one runtime prop shape lets Player, browser renderer, Remotion Studio/CLI staging, and tests exercise the same `ToraVideo → StoryRenderer → Scene` component tree.

## Runtime source resolution

Render-critical components must resolve a Story ref as:

~~~text
bundled pose/background
  → existing staticFile(...) source

local pose/background
  → localAssetSources[ref]

local ref missing from source map
  → explicit missing-asset visual
~~~

Do not make `Tora.tsx` or `Background.tsx` read IndexedDB directly.

The composition must remain deterministic from its props.

A small provider/context is acceptable to avoid threading the source map through every component, but it must be initialized from render props rather than global browser storage.

## Bundled behavior

Existing bundled render output must remain pixel/behavior compatible:

- bundled Tora image path still comes from bundled catalog;
- bundled background path still comes from bundled catalog;
- `staticFile()` continues to be used for bundled repository assets;
- pose uses `objectFit: contain`;
- background uses `objectFit: cover`.

## Browser source preparation

Before mounting/rendering an Active Story, the web app:

1. collects distinct local refs used by the Story;
2. parses category + digest from each Story ref; those parsed values are authoritative;
3. performs exact ASSET-002 `assets[ref]` lookups and validates any legacy/corrupt row shape against the requested primary key;
4. classifies refs independently as present, missing, or corrupt; a bad row must never redirect resolution to another digest/category;
5. computes the ASSET-001 aggregate browser **metadata preflight** without consulting the `blobs` store:
   - ref count includes every distinct local Story ref, including missing/corrupt refs;
   - byte/pixel sums include each distinct digest whose valid `payloadMeta` is currently available;
6. if the preflight itself exceeds any aggregate limit, fail fast for the **whole Player/render path** before any Blob lookup;
7. otherwise, continue resolving the subset of present refs even when other refs are missing/corrupt;
8. obtain/verify Blobs for present distinct digests **sequentially, one at a time**;
9. if one present digest fails integrity, classify every ref using that digest as corrupt/unavailable, continue verifying the remaining present digests, and never expose the failed bytes;
10. defensively recompute source-byte/pixel totals from successfully verified descriptors and require equality with the metadata-preflight totals for those same verified digests;
11. if the defensive totals disagree, fail closed as an internal/storage-consistency error;
12. otherwise create runtime sources only for successfully verified refs and build a **partial** local-source map;
13. expose `resolved[]` + missing/corrupt entries + over-budget state separately from Story state.

Only refs used by the Active Story need runtime sources.

Missing/corrupt refs therefore do **not** suppress otherwise valid local images in preview. They do keep Render MP4 ineligible until every required ref resolves and verifies.

Do not load the entire My assets library into render props, and do not eagerly decode every distinct full-resolution image merely because the Story references it.

## Player states

### All assets resolved

Mount the normal Player with the source map.

### Resolution in progress

Keep the Story visible as Active but show a bounded **Resolving local assets…** readiness state and do not start MP4 rendering.

Do not briefly render a stale prior asset for the new ref.

### Over aggregate browser asset budget

A Story may be schema-valid and otherwise browser-policy-eligible while exceeding the local-asset aggregate budget from ASSET-001 during the **metadata preflight**:

- >64 distinct category-scoped local refs; or
- >256 MiB original source bytes across distinct local digests; or
- >200 MP across distinct local digests.

In that state:

- preserve the Active/candidate Story and exact refs;
- keep YAML export available for CLI use;
- suppress the normal Player rather than mounting a partial/heavy source set;
- disable Render MP4;
- show which aggregate limit was exceeded;
- because any payloadMeta-vs-bytes mismatch is corruption, normal over-budget classification happens at metadata preflight and performs zero original-Blob reads;
- verified-descriptor recomputation is only a defensive equality assertion, not a second normal over-budget branch.

This is distinct from a missing asset and must not be reported as schema-invalid.

### Corrupt local asset

A local ref whose asset row is identity-inconsistent, whose payload metadata is unusable, or whose retrieved original Blob fails ASSET-002 integrity verification is treated as unavailable for that ref/digest.

Examples include:

- Blob missing;
- Blob size disagrees with `payloadMeta.byteSize`;
- Blob bytes hash to a digest different from the requested Story ref.

In that state:

- never create a runtime source from the corrupt row/bytes;
- never let a mismatched digest/category/image reach Player/render;
- preserve the Story/ref unchanged;
- show an explicit corrupt/missing local asset recovery state at affected visual positions;
- continue resolving unrelated valid refs for partial preview while the Story remains within budget;
- block MP4 rendering;
- allow exact-file same-category reimport to repair the canonical asset row + backing records.

A valid image-B Blob stored under digest-A is therefore detected as corruption, not rendered as asset A.

### Missing local refs

When the Story is within aggregate budget, the Player remains mounted with a **partial source map**: every successfully verified local ref renders normally, while every missing/corrupt visual position shows an explicit placeholder instead of stale/fallback imagery.

Examples:

~~~text
Missing local pose
abcd…7890
~~~

~~~text
Missing local background
abcd…7890
~~~

The caption/timing/editor may continue to function.

## Missing placeholder requirements

A missing placeholder:

- is deterministic;
- identifies category;
- shows a shortened safe digest/ref identifier;
- does not call network resources;
- cannot be mistaken for the intended final video asset;
- is used only for preview/defensive composition behavior.

Production MP4 rendering with any missing/corrupt required asset is prohibited even though partial preview remains available.

## Image readiness

The existing Player blocks frame advancement while render-critical images/fonts are loading.

Local runtime-source images must participate in the same readiness guarantee.

Requirements:

- first playback frame does not advance before required local images decode/load;
- changing a local reference invalidates readiness for the new generation;
- stale completion from an older local-asset generation cannot unblock a newer Story;
- duplicate scenes using one local ref do not create unbounded duplicate storage reads/runtime sources.

Use Remotion's supported image primitives where possible.

## Browser render eligibility

Extend the current render-input gating:

~~~text
schema-valid Active Story
+ browser policy eligible
+ local asset aggregate budget eligible
+ no pending visual/YAML/import state
+ browser render capability ready
+ every required local ref present
+ every required present payload integrity-verified
=
Render MP4 eligible
~~~

Missing assets produce a specific message such as:

> Browser render is blocked because 2 local assets are unavailable in this browser.

Do not collapse missing-asset or aggregate-asset-budget state into generic Story schema rejection. Both are explicit browser asset-readiness outcomes.

## Render start ordering

Before acquiring/using the global `tora-video-engine:web-fs-render` lifecycle for an actual render:

1. snapshot the current Active Story;
2. re-evaluate browser Story policy;
3. re-read/validate every required canonical asset row and `payloadMeta`, then defensively recheck metadata aggregate browser budget without consulting `blobs`;
4. for **render**, require that no ref is missing/corrupt before proceeding to payload work;
5. verify all required present digests sequentially (`MAX_CONCURRENT_INTEGRITY_CHECKS = 1`), deriving actual format/dimensions/size from each Blob and checking SHA-256;
6. if any integrity failure appears, fail render readiness immediately after safely releasing that digest's transient resources; do not start MP4;
7. defensively recompute byte/pixel totals from verified descriptors and require equality with metadata-preflight totals for the same digest set; any disagreement fails closed as corruption/internal consistency failure;
8. release transient byte/hash/decode buffers before moving between digests; never fan out all Blob `arrayBuffer()`/digest operations;
9. resolve/snapshot all verified local asset sources for that Story;
10. hold the verified runtime sources/Blob snapshots stable;
11. continue through existing capability/lock/OPFS/render lifecycle.

If readiness changes before the render transaction actually begins, fail closed and require a fresh Render action.

Do not hold the global render lock merely while waiting for user asset import.

## Frozen render snapshot

Once rendering begins:

- Story snapshot is immutable;
- local-source map is immutable;
- runtime sources referenced by that snapshot remain valid until render settles and cleanup/download materialization completes;
- library import/rename/delete/apply controls are disabled by the authoring lock;
- a cross-tab delete of the durable IndexedDB entry must not invalidate an already-materialized Blob/runtime-source snapshot in the rendering tab.

After render settlement, refresh readiness from durable library state.

## Browser renderer props

`renderMediaOnWeb()` must receive the same runtime local-source map as Player for the frozen Story snapshot.

Conceptually:

~~~ts
renderMediaOnWeb({
  composition: {
    ...
    defaultProps: {
      story,
      localAssetSources,
    },
  },
  inputProps: {
    story,
    localAssetSources,
  },
  ...
});
~~~

Do not fetch IndexedDB from inside render frames.

## Runtime source transport

ASSET-001 is the mandatory gate that proves the chosen browser runtime transport against pinned Remotion `4.0.529` with `allowHtmlInCanvas: false`.

ASSET-004 must consume that accepted transport; it must not reopen the transport decision implicitly.

If ASSET-001 accepted `blob:` object URLs, use them. If ASSET-001 had to choose a different ephemeral transport, use that proven transport while preserving the same Story refs and IndexedDB Blob storage.

Under no outcome may runtime image bytes/base64 be persisted into Story/YAML.

## Runtime source lifecycle

Use a bounded source manager that:

- creates one runtime source per needed Blob/digest where practical;
- shares it across repeated scene refs;
- preserves it for Player/render consumers;
- releases/revokes obsolete sources only after no current consumer/render snapshot can use them;
- releases all owned ephemeral sources on app teardown.

When the accepted transport is `blob:`, this specifically means `URL.createObjectURL()` + bounded `URL.revokeObjectURL()` lifecycle.

A deleted asset may keep an already-materialized runtime source alive only for the lifetime of an in-flight frozen render; new readiness checks see it as missing.

## Browser download result

No change to v0.2 output semantics except visual source origin.

A custom-asset browser render must still produce:

- H.264 MP4;
- video-only in v0.3;
- 1080 × 1920;
- 30 FPS;
- existing Story-derived duration;
- same cancellation/OPFS cleanup guarantees.

## Tests

Minimum unit/browser coverage:

- bundled-only Story renders without `localAssetSources`;
- local pose resolves through runtime map and uses contain behavior;
- local background resolves through runtime map and uses cover behavior;
- missing pose/background render explicit placeholders in Player;
- mixed Story with valid refs + one missing ref keeps valid local images resolved and shows a placeholder only for the missing position;
- mixed Story with valid refs + one corrupt ref keeps unrelated valid local images resolved and shows a placeholder only for affected positions;
- Render MP4 remains disabled for both mixed cases until all refs resolve/verify;
- no silent bundled fallback;
- distinct local refs are collected once per Story;
- duplicate scene refs share resolved source;
- aggregate budget counts refs and distinct digests correctly;
- 64-ref / 256-MiB / 200-MP boundaries pass, while each +1/overflow case remains schema-valid/exportable but does not fetch original Blobs or mount Player/render;
- many-scene fixture with unique near-limit refs fails closed at metadata-budget stage without reading any `blobs` records;
- instrumentation proves a metadata-preflight over-budget Story consults only canonical `assets` keys/`payloadMeta`, with zero original-Blob store reads and no partial Player source map;
- Blob keyed by digest A but containing valid image-B bytes fails integrity verification and never reaches Player/render;
- Blob A with correct digest A plus payloadMeta dimensions deliberately changed from actual values is detected as corrupt/unavailable and never reaches runtime-source creation;
- no test expects deliberately under-reported payloadMeta to survive integrity verification into a later over-budget state;
- defensive verified-descriptor totals equal metadata-preflight totals for every successfully verified digest set;
- integrity verification runs sequentially with at most one digest/≤25-MiB source payload materialized for hashing at once, including a fixture near the 256-MiB aggregate source-byte limit;
- successful integrity verification is reused within the page session until a mutation/invalidation for that digest clears the cache;
- Player waits for local image readiness before frame advancement;
- rapid local ref A → B → C changes cannot let stale A/B loads unblock C;
- Render MP4 is disabled while asset resolution is pending/missing;
- render start defensively rechecks asset readiness;
- browser render receives the frozen Story + source-map snapshot;
- asset mutation controls remain locked while rendering;
- deleting durable asset from another tab does not break an already-held Blob/runtime-source render snapshot;
- after render settlement, durable deletion becomes missing state;
- browser golden renders one custom pose and one custom background through normal web renderer;
- custom-asset MP4 retains v0.2 dimensions/FPS/video-only metadata.

## Acceptance criteria

- shared Remotion components support bundled and local refs without a second renderer;
- local bytes remain outside Story/YAML;
- Player can communicate missing refs without changing Story meaning;
- Player supports partial resolution for missing/corrupt refs while preserving valid local images; browser MP4 cannot start until every required ref is present/integrity-verified;
- aggregate-over-budget state suppresses the whole Player/render source map, and aggregate budget is revalidated from verified real dimensions/size after integrity checks;
- ASSET-004 uses the ASSET-001-proven runtime transport and browser-render golden confirms resolved local images through the shared composition;
- v0.2 bundled output remains intact.

## Out of scope

- audio;
- remote URLs;
- image transcoding;
- animation/video assets;
- cloud fetch during render.

## Done when

The same Active Story and shared component tree can preview bundled/browser-local images with partial resolution for missing/corrupt refs, block MP4 until all required refs verify, fail fast for whole-preview aggregate-budget overflow, and avoid consulting heavy Blob records when metadata preflight already rejects the Story.
