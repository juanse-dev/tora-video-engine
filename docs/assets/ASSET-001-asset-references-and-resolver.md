# ASSET-001 — Asset references and resolver

> Status: **Proposed**

## Goal

Extend the Story asset boundary so poses/backgrounds may refer either to Tora's bundled images or to deterministic local custom assets, without embedding bytes or introducing a second rendering model.

This spec establishes identity and readiness only. Import/storage/UI are later specs.

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
- display label and original filename are never part of identity.

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
- valid local pose ref parses;
- valid local background ref parses;
- pose rejects background-local ref;
- background rejects pose-local ref;
- malformed digest/category/case is rejected;
- serialization round-trips local refs exactly;
- bundled catalog remains exhaustive over bundled values only;
- a schema-valid Story with missing local refs remains schema/policy-valid but asset-unready;
- the missing set is deduplicated when several scenes reference the same missing asset;
- the same digest may appear as separate pose/background refs.

## Acceptance criteria

- no existing v0.2 Story requires migration;
- Story schema can safely represent local pose/background references;
- Story/YAML contains references only, never bytes/runtime URLs;
- bundled catalog stays closed and source-controlled;
- local availability is explicitly separated from schema validity;
- browser and CLI can implement different storage mechanisms behind the same resolver/readiness contract.

## Out of scope

- browser storage implementation;
- import UI;
- CLI local folder scanning;
- remote URLs;
- non-image assets;
- formal character entities.

## Done when

A Story can carry deterministic local image refs through parse → validate → serialize → timeline/editor state without requiring the image bytes to exist in the same process.
