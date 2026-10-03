# Local Custom Assets roadmap

This directory is the implementation plan for **Tora Video Engine v0.3 — Local Custom Assets**.

Umbrella issue: [#18 — v0.3 — Local Custom Assets](https://github.com/juanse-dev/tora-video-engine/issues/18)

v0.2 established a browser-first, local-first authoring and rendering flow using a closed bundled asset vocabulary. v0.3 keeps the same Story/rendering architecture while allowing the user to bring their own local raster images.

## Product promise

A user can import a static PNG, JPEG, or static WebP image as a pose/character image or background, reuse it across Stories in the same browser/origin, preview and render with it, and keep the image entirely local to that browser/computer.

The local library is intentionally **not synchronized**. Changing computer, browser, browser profile, origin, or clearing site data may make those assets unavailable. Production, Deploy Previews, and localhost are different origins and therefore different libraries. The Story remains readable and preserves its references so the user can re-import the exact same-category files or choose replacements.

## Core invariants

1. **Story data references assets; it never contains image bytes.**
2. **Bundled and local assets are distinct inventories.** Existing Tora poses/backgrounds remain bundled; user imports appear under a separate My assets library.
3. **Existing YAML remains valid.** Values such as `formal` and `office` continue to work unchanged.
4. **Local asset identity is content-addressed.** SHA-256 of the original bytes provides a deterministic reference and natural deduplication.
5. **Display labels are metadata, not identity.** Renaming a local asset cannot invalidate Stories.
6. **Availability is not schema validity.** A Story with a syntactically valid local reference may be unavailable in the current environment; this is an explicit asset-readiness state, not a schema error.
7. **Missing assets never silently fall back.** Preview surfaces an explicit placeholder/status and MP4 rendering is blocked until required references resolve.
8. **Original bytes are preserved.** v0.3 does not recompress or resize imported source images.
9. **Each source image is bounded before expensive work.** Source bytes must be >0 and ≤25 MiB, dimensions ≤8192 px per side, and decoded pixels ≤50 MP; animated PNG/WebP is rejected.
10. **Browser custom assets remain browser-local.** IndexedDB is the v0.3 durable store; no Netlify upload, backend, cloud sync, remote URL fetch, or account is introduced.
11. **CLI custom assets remain checkout-local and content-first.** Users copy files into gitignored local asset folders; Node detects PNG/JPEG/WebP from bytes rather than trusting extension/MIME, resolves the same content-addressed refs, and exposes a required helper command to print complete copy/pasteable refs.
12. **Pose/background rendering semantics stay unchanged.** Pose images use contain behavior; backgrounds use cover behavior.
13. **Project persistence has an explicit v0.3 boundary.** v1 bundled projects remain v1 while bundled-only; the first successful durable write containing a local ref promotes atomically to v2. The existing persistence Web Lock remains unversioned.
14. **Browser render transport is gated early.** ASSET-001 must prove the pinned Remotion web renderer can render the chosen local runtime source transport before ASSET-002/003 proceed.

## Stable reference grammar

Bundled references retain their existing compact values:

~~~yaml
pose: formal
background: office
~~~

Local references use category + SHA-256:

~~~yaml
pose: local:pose:sha256:<64-lowercase-hex>
background: local:background:sha256:<64-lowercase-hex>
~~~

The category is part of the reference so a pose reference cannot accidentally satisfy a background field.

The same original bytes may be registered in both categories while sharing one stored binary payload.

## High-level architecture

~~~mermaid
flowchart LR
    Y[Story / YAML] --> R[Asset references]

    R --> B[Bundled resolver]
    R --> L[Local resolver]

    B --> P[public/ bundled assets]

    subgraph Browser
      L --> DB[Browser local asset DB]
      DB --> U[Ephemeral runtime source<br/>blob: if ASSET-001 gate passes]
      U --> Player[Remotion Player]
      U --> WebRender[Browser MP4 render]
    end

    subgraph Local checkout
      L --> F[local-assets/]
      F --> C[CLI asset index / staging]
      C --> CliRender[Remotion CLI render]
    end
~~~

The Story is shared. Asset bytes are environment-specific.

## Browser storage model

v0.3 uses a browser-local binary store separate from the existing Story `localStorage` envelope.

v0.3 uses IndexedDB because it can atomically store structured metadata, original Blobs, and bounded derivative thumbnails without mixing custom assets into Remotion's OPFS render namespace.

At minimum the library records:

~~~text
asset ref
category
SHA-256 digest
display label
original filename
MIME type
byte size
decoded width/height
original Blob
bounded derivative thumbnail (≤256×256)
~~~

Ephemeral runtime image sources are transport-only and must never be persisted in Story/YAML/localStorage. If the ASSET-001 gate accepts `blob:`, this means object URLs; otherwise the proven replacement transport follows the same rule.

## Browser active-Story asset budget

Per-file limits are not sufficient for a Story that references many distinct local assets.

Before loading original Blobs for Player/render, v0.3 reads metadata only and enforces:

~~~text
≤64 distinct category-scoped local refs
≤256 MiB original source bytes across distinct digests
≤200 MP across distinct digests
~~~

A Story above this browser-only budget remains schema-valid and YAML-exportable for CLI use, but Player/render is suppressed and original Blobs are not eagerly materialized.

## Local CLI model

The checkout gets a user-owned, gitignored area:

~~~text
local-assets/
  poses/
  backgrounds/
~~~

A user can copy files there regardless of extension. The CLI stats them for the cheap byte-size bound, detects/validates static PNG/JPEG/WebP from content, validates dimensions, hashes accepted bytes, builds a category-aware index, resolves required local references, and makes matched files available to the Remotion render without altering the Story or tracked bundled assets. A required `npm run assets`-style helper prints the full canonical refs for local-only authoring.

This deliberately mirrors the browser model:

~~~text
same YAML ref
    ├── browser → browser-local library
    └── CLI     → local-assets/ folder
~~~

## Implementation order

| Spec | Deliverable | Depends on |
| --- | --- | --- |
| [ASSET-001](./ASSET-001-asset-references-and-resolver.md) | Backward-compatible refs, persistence v2 boundary, readiness, browser transport gate | v0.2 |
| [ASSET-002](./ASSET-002-browser-local-asset-storage.md) | IndexedDB library, hashing, dedup, static-image/resource validation | ASSET-001 gate accepted |
| [ASSET-003](./ASSET-003-import-and-library-ui.md) | Bundled/My assets UI, import, rename, delete, missing-state UX | ASSET-002 |
| [ASSET-004](./ASSET-004-preview-and-browser-rendering.md) | Player/browser-render resolution of local images | ASSET-001, ASSET-002 |
| [ASSET-005](./ASSET-005-cli-local-assets.md) | Gitignored local folders, ref discovery helper, CLI resolution/staging | ASSET-001 |
| [ASSET-006](./ASSET-006-persistence-and-production-verification.md) | Verify migration/cross-version behavior, lifecycle coverage, production golden | ASSET-003, ASSET-004, ASSET-005 |

## v0.3 UX target

The asset catalog should make origin obvious:

~~~text
POSES

Bundled
[Formal] [Confused] [Panic] [Coffee]

My assets
[My cat] [Another pose] [+ Import]


BACKGROUNDS

Bundled
[Office] [Server room]

My assets
[Apartment] [Bogotá] [+ Import]
~~~

A local asset card supports:

- thumbnail;
- human-readable label;
- rename;
- apply to selected scene;
- delete.

Deletion of an asset used by the current Story requires explicit confirmation and may intentionally leave unresolved references. `Reset project` and importing/replacing a Story do not delete My assets; library deletion is always an explicit asset action.

## Missing-reference behavior

An unavailable local reference remains part of the Story.

The application must:

- preserve the exact reference;
- identify which scenes are affected;
- show a visible missing-asset placeholder/status;
- allow YAML editing/export;
- disable MP4 rendering while any required asset is unresolved;
- offer re-import/replacement;
- automatically resolve when the exact original file is imported again in the same category.

No fallback to a bundled pose/background is allowed.

## v0.3 exit criteria

v0.3 is complete when:

- existing v0.2 bundled YAML/Story content remains unchanged; bundled-only persisted v1 projects stay v1 until first successful local-ref persistence promotes them atomically to v2;
- static PNG/JPEG/WebP pose/background imports reject APNG/animated WebP and enforce ≤25 MiB, ≤8192 px per side, and ≤50 MP;
- user assets remain visually separated from bundled assets;
- catalog thumbnails are generated derivatives ≤256×256, never full-resolution originals, with at most 50 local thumbnail cards mounted at once;
- original bytes persist in the same browser/origin across reloads;
- exact duplicate bytes do not create duplicate binary storage, and exact duplicate reimport repairs missing/corrupt backing Blob/thumbnail data;
- renaming a local asset does not change YAML references;
- YAML exports contain local references but no image bytes/blob URLs;
- missing references are explicit and block render rather than changing output silently;
- exact-file same-category re-import resolves a missing reference by SHA-256;
- delete-in-use is allowed only after warning;
- Player and browser MP4 rendering work with local pose/background assets within the aggregate browser asset budget;
- the CLI resolves the same refs from `local-assets/` by content even with absent/incorrect extensions, and a required helper prints complete canonical refs;
- missing CLI assets fail before Remotion with actionable diagnostics;
- the pinned Remotion browser-render transport is proven before full browser library rollout;
- production remains static-hosted and backend-free.

## Explicitly out of scope

- cloud asset sync;
- accounts/authentication;
- server uploads;
- remote asset URLs;
- project ZIP/bundle export with image bytes;
- SVG;
- GIF/animated images, including APNG/animated WebP;
- video assets;
- audio/TTS/music;
- custom fonts;
- props/overlays/effects;
- AI image generation;
- formal character packs / multiple-character domain modeling.
