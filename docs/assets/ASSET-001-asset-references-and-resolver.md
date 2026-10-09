# ASSET-001 — Asset references, persistence v2 and composition contract

> Status: **Proposed**
>
> Depends on: v0.2 (current `main`). Read [README](./README.md) first: invariants (`INV-n`), constants and decisions (`D-n`) live there.

## Goal

Let a Story carry local pose/background refs through parse → validate → serialize → timeline → editor → persistence, and teach the shared Remotion composition to draw a local image from an ephemeral source map (or a placeholder when the source is absent). No storage, import UI or CLI scanning yet.

## Decisions specific to this spec

- The Story-facing types widen: `Pose` and `Background` (exported from `src/story/types.ts`) now mean *bundled value **or** local ref*. New `BundledPose` / `BundledBackground` types name the closed bundled sets. Widening the existing names makes the TypeScript compiler point at every place that must be checked.
- The `localAssetSources` prop is optional. Every existing caller that passes only `{story}` keeps working, and bundled output is pixel-identical.
- The browser transport (`blob:`) is already proven (D-1). This spec does not build a harness page; ASSET-004 commits the MP4 golden that exercises it end-to-end.

## Files

| Action | Path | Purpose |
| --- | --- | --- |
| create | `src/localAssets/limits.ts` | All `MAX_*` constants from the README table that live here. |
| create | `src/localAssets/refs.ts` | Ref grammar, parse/build helpers, type guards. |
| create | `src/localAssets/sources.ts` | `LocalAssetSource`, `LocalAssetSourceMap`, `STAGED_LOCAL_ASSETS_DIR`, `shortAssetId()`. |
| create | `src/localAssets/readiness.ts` | Pure functions: collect refs/usages, evaluate aggregate budget. |
| create | `src/components/visualAssetSource.tsx` | React context + `useVisualAssetSrc()` hook. |
| create | `src/components/MissingAssetPlaceholder.tsx` | Deterministic placeholder for a missing local pose/background. |
| modify | `src/story/schema.ts` | `PoseSchema` / `BackgroundSchema` accept local refs. |
| modify | `src/story/types.ts` | Export `BundledPose`, `BundledBackground`, `LocalAssetRef`, etc. |
| modify | `src/assets.ts` | Catalog exhaustive over `BundledPose` / `BundledBackground` only. |
| modify | `src/Video.tsx` | `ToraVideoProps.localAssetSources?`; provide context. |
| modify | `src/components/Tora.tsx`, `src/components/Background.tsx` | Resolve through `useVisualAssetSrc()`. |
| modify | `src/web/persistence.ts`, `src/web/App.tsx` | Persistence envelope v1/v2. |
| create | `tests/local-asset-refs.test.mjs`, `tests/local-asset-readiness.test.mjs`, `tests/local-asset-composition.test.mjs`, `tests/persistence-v2.test.mjs` | Unit tests. |

## Interfaces

### `src/localAssets/refs.ts`

~~~ts
export const localAssetCategories = ["pose", "background"] as const;
export type LocalAssetCategory = (typeof localAssetCategories)[number];

export type LocalPoseRef = `local:pose:sha256:${string}`;
export type LocalBackgroundRef = `local:background:sha256:${string}`;
export type LocalAssetRef = LocalPoseRef | LocalBackgroundRef;

export const LOCAL_ASSET_REF_PATTERN =
  /^local:(pose|background):sha256:[0-9a-f]{64}$/u;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

export const isLocalAssetRef = (value: string): value is LocalAssetRef;
export const isLocalPoseRef = (value: string): value is LocalPoseRef;
export const isLocalBackgroundRef = (value: string): value is LocalBackgroundRef;

/** Returns null for anything that is not an exact canonical local ref. */
export const parseLocalAssetRef = (
  value: string,
): {category: LocalAssetCategory; digest: string} | null;

/** Throws if digest is not 64 lowercase hex. */
export const buildLocalAssetRef = (
  category: LocalAssetCategory,
  digest: string,
): LocalAssetRef;

/** Primary-key prefix for one category, e.g. "local:pose:sha256:". */
export const localAssetRefPrefix = (category: LocalAssetCategory): string;
~~~

### `src/story/schema.ts`

Keep the exported `poses` / `backgrounds` arrays (they are the bundled sets). Replace the enum schemas:

~~~ts
export const BundledPoseSchema = z.enum(poses);
export const BundledBackgroundSchema = z.enum(backgrounds);

export const PoseSchema = z.custom<BundledPose | LocalPoseRef>(
  (value) =>
    typeof value === "string" &&
    (BundledPoseSchema.safeParse(value).success || isLocalPoseRef(value)),
  {message: "Pose must be formal, confused, panic, coffee, or local:pose:sha256:<64 lowercase hex>"},
);

export const BackgroundSchema = z.custom<BundledBackground | LocalBackgroundRef>(
  (value) =>
    typeof value === "string" &&
    (BundledBackgroundSchema.safeParse(value).success || isLocalBackgroundRef(value)),
  {message: "Background must be office, server-room, or local:background:sha256:<64 lowercase hex>"},
);
~~~

Use `z.custom` exactly like this. Verified with the pinned `zod@4.6.5`: a `z.union([...], {error})` would report the inner regex error instead of this message. `StorySceneSchema` keeps using `PoseSchema` / `BackgroundSchema`; `BundledPose` / `BundledBackground` are `z.infer` of the bundled enums (define them before these schemas).

### `src/story/types.ts`

Add exports: `BundledPose`, `BundledBackground` (inferred from the bundled schemas) and re-export `LocalAssetRef`, `LocalPoseRef`, `LocalBackgroundRef`, `LocalAssetCategory` from `src/localAssets/refs.ts`. `Pose` / `Background` are now the widened union types.

### `src/assets.ts`

Change every `Record<Pose, …>` to `Record<BundledPose, …>` and every `Record<Background, …>` to `Record<BundledBackground, …>`. Add:

~~~ts
export const isBundledPose = (value: string): value is BundledPose;
export const isBundledBackground = (value: string): value is BundledBackground;
~~~

Local assets are never added to these constants (INV-2).

### `src/localAssets/sources.ts`

~~~ts
export const STAGED_LOCAL_ASSETS_DIR = "__local-assets";

export type LocalAssetSource =
  | {kind: "url"; url: string}      // browser: blob: object URL
  | {kind: "static"; path: string}  // CLI: path inside the temporary public dir
  | {kind: "pending"};              // browser preview: still resolving (never passed to a render)

export type LocalAssetSourceMap = Readonly<
  Partial<Record<LocalAssetRef, LocalAssetSource>>
>;

/** "abcd…7890": first 4 and last 4 hex chars of the digest. */
export const shortAssetId = (ref: LocalAssetRef): string;
~~~

Source-map values are runtime-only (INV-1). They are passed as props and never persisted or serialized.

### Resolution function (in `src/localAssets/sources.ts`)

Node unit tests run with `--experimental-strip-types`, which cannot load `.tsx`. Keep every decision in a pure `.ts` function and make the React pieces thin wrappers:

~~~ts
export type VisualAssetResolution =
  | {kind: "image"; src: string}
  | {kind: "pending"; category: LocalAssetCategory; ref: LocalAssetRef}
  | {kind: "missing"; category: LocalAssetCategory; ref: LocalAssetRef};

export const resolveVisualAssetSrc = (
  category: LocalAssetCategory,
  value: Pose | Background,
  sources: LocalAssetSourceMap | undefined,
  toStaticUrl: (path: string) => string, // pass Remotion's staticFile
): VisualAssetResolution;
~~~

Resolution rules, in order:

1. bundled value → `{kind: "image", src: toStaticUrl(<catalog previewPath>)}` (current behavior);
2. local ref with `{kind: "url"}` source → `{kind: "image", src: source.url}`;
3. local ref with `{kind: "static"}` source → `{kind: "image", src: toStaticUrl(source.path)}`;
4. local ref with `{kind: "pending"}` source → `{kind: "pending", …}`;
5. local ref without an entry → `{kind: "missing", …}`.

### `src/components/visualAssetSource.tsx`

~~~ts
export const LocalAssetSourcesProvider: React.FC<{
  sources: LocalAssetSourceMap | undefined;
  children: React.ReactNode;
}>;

/** Reads the context and calls resolveVisualAssetSrc(category, value, sources, staticFile). */
export const useVisualAssetSrc = (
  category: LocalAssetCategory,
  value: Pose | Background,
): VisualAssetResolution;
~~~

The hook only reads React context initialized from props. It must not touch IndexedDB, `window`, the network, or the filesystem.

### `src/components/MissingAssetPlaceholder.tsx`

~~~ts
export const MissingAssetPlaceholder: React.FC<{
  category: LocalAssetCategory;
  ref: LocalAssetRef;
  variant: "missing" | "pending";
}>;
~~~

Renders, filling its parent box:

- solid `backgroundColor` `#1f2430` for backgrounds; for poses a centered box `#2b3140` at 60% width/height of its parent;
- two lines of text, centered with flexbox: `Missing local pose` / `Missing local background` (variant `pending`: `Loading local pose…` / `Loading local background…`), then `shortAssetId(ref)`;
- variant `missing`: `data-missing-local-asset={ref}`; variant `pending`: `data-pending-local-asset={ref}`; both `role="img"` with an `aria-label` repeating the visible text.

Respect the web-renderer compatibility audit (`tests/web-renderer-compat.test.mjs`): no `background:` shorthand, `textAlign`, `zIndex`, `objectPosition`, `boxSizing`, `overflowWrap` or `wordBreak`. Use `fontFamily: "Inter, sans-serif"` as `src/Video.tsx` does.

### `src/Video.tsx`

~~~ts
export type ToraVideoProps = {
  story: Story;
  localAssetSources?: LocalAssetSourceMap;
};
~~~

Wrap `<StoryRenderer>` in `<LocalAssetSourcesProvider sources={localAssetSources}>`. `Tora` and `Background` call `useVisualAssetSrc` and render `<Img pauseWhenLoading …>` for `image`, or `<MissingAssetPlaceholder variant=…>` for `missing` / `pending`. Keep `objectFit: contain` (pose) and `cover` (background) exactly (INV-10).

### `src/localAssets/readiness.ts`

~~~ts
export type LocalAssetUsage = {
  ref: LocalAssetRef;
  category: LocalAssetCategory;
  digest: string;
  sceneIndexes: number[]; // 0-based, ascending, a scene appears once per ref
};

/** Distinct local refs in first-appearance order (scene order, pose before background). */
export const collectStoryLocalAssetUsages = (story: Story): LocalAssetUsage[];

export const storyHasLocalAssetRefs = (story: Story): boolean;

export type PayloadMetadata = {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteSize: number;
  width: number;
  height: number;
};

export type LocalAssetBudgetResult =
  | {ok: true; refCount: number; totalBytes: number; totalPixels: number}
  | {
      ok: false;
      refCount: number;
      totalBytes: number;
      totalPixels: number;
      exceeded: Array<"refs" | "bytes" | "pixels">;
    };

/**
 * refCount = number of usages (missing/corrupt included).
 * Bytes and pixels are summed once per distinct digest that has metadata.
 * A value equal to its limit passes; one above fails.
 */
export const evaluateLocalAssetBudget = (
  usages: readonly LocalAssetUsage[],
  metadataByDigest: ReadonlyMap<string, PayloadMetadata>,
): LocalAssetBudgetResult;

export const describeBudgetFailure = (
  result: Extract<LocalAssetBudgetResult, {ok: false}>,
): string; // e.g. "Uses 70 local assets (limit 64)." — one sentence per exceeded limit
~~~

These are pure; ASSET-004 wires them to storage.

## Persistence envelope v1 / v2

Current state: `src/web/persistence.ts` writes `{version: 1, story}` and treats any other version as `unsupported-version` raw recovery. That is exactly how a v0.2 tab will treat a v2 envelope, so v0.2 needs no change.

Rules:

1. Restore accepts `version: 1` and `version: 2`. Any other version stays `unsupported-version` recovery.
2. A `version: 1` envelope whose story contains a local ref is `schema-invalid` recovery with message `"Stored project version 1 cannot contain local asset references."`.
3. `RestoreResult` gains `durableVersion: 1 | 2 | null` (`null` when nothing was restored).
4. The version written is `max(durableVersion ?? 1, storyHasLocalAssetRefs(story) ? 2 : 1)`. So bundled-only projects stay v1 (v0.2 rollback works), the first successful write containing a local ref promotes to v2, and v2 never downgrades.
5. `serializePersistedEnvelope(story, durableVersion)` takes the current durable version and returns `{serialized, version}`.
6. In `App.tsx`, keep a `durableVersion` state next to `durableStory`. Set it from every `restorePersistedProject` result (initial load, ownership acquisition rereads, conflict rereads) and from every successful write. Do not change it when a write fails, so a failed promotion leaves the stored v1 envelope untouched and the existing unpersisted/loss-risk warning appears.
7. The persistence lock name `PERSISTENCE_WRITER_LOCK` and storage key do not change. Only the owner writes (already enforced by `persistStory`).

The asset IndexedDB (ASSET-002) has its own unrelated schema version.

## Tasks

- [ ] **1. Ref grammar, schema and types.** Create `limits.ts`, `refs.ts`; update `schema.ts`, `types.ts`, `assets.ts`; fix every TypeScript error the widening produces (expected in `renderPlan.ts`, `Scene.tsx`, `components/*`, `web/visualDraft.ts`, `web/components/AssetCatalog.tsx`). Where code indexes a bundled catalog with a Story value, guard with `isBundledPose` / `isBundledBackground`. Tests: `tests/local-asset-refs.test.mjs`.
- [ ] **2. Composition contract.** Create `sources.ts`, `visualAssetSource.tsx`, `MissingAssetPlaceholder.tsx`; update `Video.tsx`, `Tora.tsx`, `Background.tsx`. Tests: `tests/local-asset-composition.test.mjs`; extend `tests/web-renderer-compat.test.mjs` to audit `MissingAssetPlaceholder.tsx` with the same forbidden-style list.
- [ ] **3. Readiness and budget functions.** Create `readiness.ts`. Tests: `tests/local-asset-readiness.test.mjs`.
- [ ] **4. Persistence v1/v2.** Update `persistence.ts` and `App.tsx`. Tests: `tests/persistence-v2.test.mjs`; keep `tests/web-yaml-persistence.test.mjs` and `tests/browser/yaml-persistence.spec.mjs` green.

## Tests

`tests/local-asset-refs.test.mjs`

- every existing fixture (`stories/*.yaml`, `exampleStory`) still parses unchanged;
- valid local pose ref parses in `pose`; valid local background ref parses in `background`;
- `pose: local:background:sha256:…` and `background: local:pose:sha256:…` are rejected with the custom message;
- rejected: uppercase hex, 63/65 hex chars, `sha1`, unknown category, leading/trailing spaces, `local:pose:sha256:` with no digest;
- `parseLocalAssetRef` / `buildLocalAssetRef` round-trip; `buildLocalAssetRef` throws on bad digest;
- `serializeStorySource` → `parseStorySource` round-trips local refs byte-identically and the YAML contains the ref as a plain scalar;
- bundled catalogs have exactly the bundled keys (no local refs).

`tests/local-asset-composition.test.mjs` (Node cannot import `.tsx`; test the pure function and audit component sources as text, like `tests/web-renderer-compat.test.mjs` does)

- `resolveVisualAssetSrc` maps bundled pose/background to the same catalog path as before (pass an identity `toStaticUrl`);
- local ref + `{kind: "url"}` → that URL; + `{kind: "static"}` → `toStaticUrl(path)`;
- local ref + `{kind: "pending"}` → `{kind: "pending"}`; local ref without entry → `{kind: "missing"}` with the right category;
- a pose ref never resolves from a background entry and vice versa (separate keys);
- source audit: `Tora.tsx` and `Background.tsx` call `useVisualAssetSrc` and still contain `objectFit: "contain"` / `objectFit: "cover"`; `MissingAssetPlaceholder.tsx` contains `data-missing-local-asset`;
- browser check (add one case to `tests/browser/player-readiness.spec.mjs` or a new `tests/browser/local-asset-composition.spec.mjs`): the bundled reference Story still shows no `[data-missing-local-asset]` element in the Player.

`tests/local-asset-readiness.test.mjs`

- usages deduplicate repeated refs and list scene indexes;
- the same digest as pose and as background yields two usages;
- budget: 64 refs pass / 65 fail; exactly 256 MiB pass / +1 byte fail; exactly 200 MP pass / +1 pixel fail;
- missing metadata counts toward refs but not bytes/pixels;
- two refs sharing a digest count its bytes/pixels once;
- several limits exceeded at once are all listed in `exceeded`.

`tests/persistence-v2.test.mjs`

- v1 bundled envelope restores with `durableVersion: 1`;
- serializing a bundled story with `durableVersion 1` writes v1; with a local ref writes v2; with `durableVersion 2` and bundled story writes v2;
- v2 envelope with local refs restores with `durableVersion: 2`;
- v1 envelope containing a local ref → `schema-invalid` recovery;
- `version: 3` → `unsupported-version` recovery;
- simulated v0.2 reader (`version !== 1` check) rejects a v2 envelope as unsupported (documents rollback behavior).

## Verify

~~~bash
npm test
npm run lint
npm run web:build
npm run test:browser
~~~

## Out of scope

Storage, import UI, CLI scanning, integrity verification, Player/render wiring (ASSET-002 to ASSET-005).

## Done when

All four tasks are ticked, a Story with local refs round-trips through YAML and persistence (promoting v1 → v2 only when needed), and the composition draws a provided local source or an explicit placeholder without any change to bundled output.
