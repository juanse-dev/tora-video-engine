# ASSET-001 — Asset references and resolver

> Status: **Proposed**

## Goal

Extend the Story asset boundary so poses/backgrounds may refer either to Tora's bundled images or to deterministic local custom assets, without embedding bytes or introducing a second rendering model.

This spec establishes identity/readiness, the v0.3 project-persistence version boundary, and a mandatory browser-render transport spike. Import/storage/UI are later specs.

## Backward compatibility

Existing Stories must remain valid unchanged:

~~~yaml
pose: formal
background: office
~~~

The existing bundled values remain the canonical bundled references for v0.3.

Do **not** rewrite old Stories to a new `bundled:` prefix.

## Local reference grammar

Local image references are content-addressed and category-scoped:

~~~text
local:pose:sha256:<64-lowercase-hex>
local:background:sha256:<64-lowercase-hex>
~~~

Examples:

~~~yaml
pose: local:pose:sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
background: local:background:sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
~~~

Requirements:

- hash algorithm is SHA-256 over the **original file bytes**;
- digest is serialized as exactly 64 lowercase hexadecimal characters;
- category is part of the ref;
- pose fields accept only bundled poses or `local:pose:...`;
- background fields accept only bundled backgrounds or `local:background:...`;
- malformed/uppercase/truncated/unknown-category local refs fail Story schema validation;
- display label and original filename are never part of identity;
- labels do not need to be unique;
- two visually identical images with different encoded bytes intentionally produce different refs.

The same original bytes may therefore yield two category-specific refs with the same digest.

## Type boundary

Split today's finite bundled types from the Story-facing reference types.

Conceptually:

~~~ts
type BundledPose = "formal" | "confused" | "panic" | "coffee";
type BundledBackground = "office" | "server-room";

type LocalPoseRef =
  `local:pose:sha256:${LowercaseSha256}`;

type LocalBackgroundRef =
  `local:background:sha256:${LowercaseSha256}`;

type PoseRef = BundledPose | LocalPoseRef;
type BackgroundRef = BundledBackground | LocalBackgroundRef;
~~~

Exact implementation may use branded strings/Zod refinements rather than a literal `LowercaseSha256` type.

The Story fields remain named `pose` and `background` in v0.3. Formal character-pack/multi-character modeling remains out of scope.

## Catalog compatibility

`src/assets.ts` currently assumes `Record<Pose, ...>`, which stops being correct once Story pose refs are open to valid local hashes.

Refactor the bundled catalog so it is exhaustive over **BundledPose** / **BundledBackground**, not over every possible Story ref.

The bundled catalog remains the source of truth for:

- bundled id;
- label;
- preview/static path;
- category.

Local library metadata is a separate inventory and must not be merged into source-controlled bundled catalog constants.

## Project persistence version boundary

Existing bundled Story/YAML **content** remains valid unchanged, but v0.3 expands the valid domain of `pose` and `background`. Therefore browser project persistence must explicitly advance before any local ref can be durably written.

Change:

~~~text
PERSISTENCE_VERSION = 1
~~~

to:

~~~text
PERSISTENCE_VERSION = 2
~~~

ASSET-001 owns the migration/version boundary:

- a valid v1 bundled-only persisted Story migrates deterministically to a v2 envelope with identical Story content;
- v2 does not contain image bytes or asset-library metadata; it only permits the expanded Story refs;
- malformed/unsupported v1 recovery behavior remains protected;
- an old v0.2 tab encountering a v2 envelope treats it as unsupported-version/recovery rather than claiming to understand and then schema-rejecting a local ref;
- the existing physical Story/recovery storage slots remain shared;
- the persistence Web Lock name remains **unversioned** while those physical slots are shared across old/new bundles;
- only the tab that owns the existing persistence-writer lock may durably migrate/write the v2 envelope; secondary/session-only tabs must not perform a migration write and must follow the existing ownership/retry/conflict rules.

The custom asset IndexedDB introduced by ASSET-002 has its own independent database schema version.

Existing v0.2 YAML files do not require content migration. This persistence-envelope migration is a browser durable-state compatibility measure.

## Availability is not schema validity

A local ref may be syntactically valid but absent from the current browser/checkout.

That must **not** make the Story schema-invalid.

Separate these concepts:

~~~text
schema validity
      ↓
browser authoring policy
      ↓
asset readiness
      ↓
preview/render readiness
~~~

A Story with an unavailable local ref:

- remains parseable/serializable/exportable;
- may remain the Active Story;
- is persisted with the exact unresolved ref;
- surfaces an explicit missing-asset state;
- cannot start MP4 rendering until all required local refs resolve.

This separation is necessary for YAML moved between computers/browsers.

## Shared asset-readiness boundary

Introduce one environment-neutral way to enumerate and evaluate required visual refs.

Suggested responsibilities:

~~~ts
collectStoryVisualAssetRefs(story): VisualAssetRef[]

evaluateStoryAssetReadiness(
  story,
  resolver,
): Promise<StoryAssetReadiness>
~~~

A useful result shape is conceptually:

~~~ts
type StoryAssetReadiness =
  | {
      ready: true;
      resolved: ResolvedVisualAsset[];
    }
  | {
      ready: false;
      resolved: ResolvedVisualAsset[];
      missing: MissingVisualAsset[];
    };
~~~

Resolution must retain:

- exact Story ref;
- category;
- whether origin is bundled/local;
- runtime source needed by the consuming environment when resolved.

Do not put environment-specific Blob URLs, filesystem paths, or static URLs into the Story.

## Bundled resolver

Bundled refs resolve deterministically from the source-controlled catalog and existing static paths.

The v0.2 behavior for Tora's bundled assets must remain unchanged.

## Local resolver contract

A local resolver receives the exact local ref and either:

- returns the environment's resolved image source + metadata; or
- reports that the ref is missing/unavailable.

The browser and Node implementations may differ in how they produce a runtime source, but they must consume the same Story ref grammar.

## Browser render transport gate

Before ASSET-002/003 build the full local library, ASSET-001 must prove that the pinned Remotion `4.0.529` browser renderer can consume a local image through the intended runtime transport.

Primary spike:

~~~text
bounded local Blob
      ↓
URL.createObjectURL()
      ↓
shared Remotion <Img>
      ↓
renderMediaOnWeb()
      ↓
valid MP4 containing the local image
~~~

Requirements:

- use the pinned Remotion version;
- use the normal v0.2 web-render path;
- keep `allowHtmlInCanvas: false`;
- do not embed image bytes/base64 into Story/YAML;
- verify the rendered MP4 actually contains the local image, not only that render completes;
- verify object-URL lifetime is sufficient for the render.

If `blob:` succeeds reliably, it becomes the browser runtime transport used by later specs.

If it fails, revise only the ephemeral runtime transport and re-prove the spike. The stable ref grammar, SHA-256 identity, IndexedDB storage choice, and missing-asset semantics stay unchanged.

**ASSET-002/003 must not proceed until this gate passes or a replacement runtime transport is deliberately proven.**

## Editor state implications

Asset availability becomes another derived render-readiness input; it is **not** a pending visual draft.

For example:

~~~text
valid Story + eligible browser policy + missing local image
=
Active Story preserved
YAML export enabled
visual editing enabled
preview shows explicit missing state
Render MP4 disabled
~~~

Changing the selected pose/background still uses the existing visual draft → StorySchema → browser policy → Active Story commit path.

## Serialization

`serializeStorySource()` must preserve local refs exactly as scalar strings.

Canonical YAML must not contain:

- Blob URLs;
- base64/data URLs;
- image bytes;
- local filesystem paths;
- browser database keys other than the stable ref itself.

## Tests

Minimum automated coverage:

- all existing bundled Story fixtures remain valid unchanged;
- v1 bundled persisted project migrates deterministically to v2 with identical Story content;
- a v2 project containing local refs is not written using the v1 envelope version;
- cross-version persistence keeps the existing unversioned writer lock;
- only the persistence owner performs the v1 → v2 durable migration; secondary tabs do not rewrite the shared envelope;
- valid local pose ref parses;
- valid local background ref parses;
- pose rejects background-local ref;
- background rejects pose-local ref;
- malformed digest/category/case is rejected;
- serialization round-trips local refs exactly;
- bundled catalog remains exhaustive over bundled values only;
- a schema-valid Story with missing local refs remains schema/policy-valid but asset-unready;
- the missing set is deduplicated when several scenes reference the same missing asset;
- the same digest may appear as separate pose/background refs;
- pinned web-render spike renders a local Blob/runtime source into an MP4 with the expected image.

## Acceptance criteria

- no existing v0.2 Story/YAML content requires mutation;
- valid persisted v1 bundled projects migrate safely to persistence envelope v2 before local refs may be persisted;
- Story schema can safely represent local pose/background references;
- Story/YAML contains references only, never bytes/runtime URLs;
- bundled catalog stays closed and source-controlled;
- local availability is explicitly separated from schema validity;
- browser and CLI can implement different storage mechanisms behind the same resolver/readiness contract;
- browser runtime source transport is proven against pinned Remotion before ASSET-002/003.

## Out of scope

- browser storage implementation;
- import UI;
- CLI local folder scanning;
- remote URLs;
- non-image assets;
- formal character entities.

## Done when

A Story can carry deterministic local image refs through parse → validate → serialize → timeline/editor state, v1 project persistence safely upgrades to v2, and the browser render transport gate is proven without putting asset bytes into Story data.
