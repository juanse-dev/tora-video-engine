# Local Custom Assets roadmap

This directory is the implementation plan for **Tora Video Engine v0.3 — Local Custom Assets**.

Umbrella issue: [#18 — v0.3 — Local Custom Assets](https://github.com/juanse-dev/tora-video-engine/issues/18)

v0.2 established a browser-first, local-first authoring and rendering flow using a closed bundled asset vocabulary. v0.3 keeps the same Story/rendering architecture while allowing the user to bring their own local raster images.

## Product promise

A user can import a PNG, JPEG, or WebP image as a pose/character image or background, reuse it across Stories in the same browser, preview and render with it, and keep the image entirely local to that browser/computer.

The local library is intentionally **not synchronized**. Changing computer, browser, browser profile, or clearing site data may make those assets unavailable. The Story remains readable and preserves its references so the user can re-import the exact files or choose replacements.

## Core invariants

1. **Story data references assets; it never contains image bytes.**
2. **Bundled and local assets are distinct inventories.** Existing Tora poses/backgrounds remain bundled; user imports appear under a separate My assets library.
3. **Existing YAML remains valid.** Values such as `formal` and `office` continue to work unchanged.
4. **Local asset identity is content-addressed.** SHA-256 of the original bytes provides a deterministic reference and natural deduplication.
5. **Display labels are metadata, not identity.** Renaming a local asset cannot invalidate Stories.
6. **Availability is not schema validity.** A Story with a syntactically valid local reference may be unavailable in the current environment; this is an explicit asset-readiness state, not a schema error.
7. **Missing assets never silently fall back.** Preview surfaces an explicit placeholder/status and MP4 rendering is blocked until required references resolve.
8. **Original bytes are preserved.** v0.3 does not recompress or resize imported source images.
9. **Each source image is bounded to 25 MiB before hashing/decoding/storage.**
10. **Browser custom assets remain browser-local.** No Netlify upload, backend, cloud sync, remote URL fetch, or account is introduced.
11. **CLI custom assets remain checkout-local.** Users copy supported files into gitignored local asset folders; Tora resolves the same content-addressed references.
12. **Pose/background rendering semantics stay unchanged.** Pose images use contain behavior; backgrounds use cover behavior.

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
      DB --> U[Object URLs]
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

The planned implementation uses IndexedDB because it can atomically store structured metadata and Blob values without mixing custom assets into Remotion's OPFS render namespace.

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
~~~

Blob/object URLs are runtime-only and must never be persisted in Story/YAML/localStorage.

## Local CLI model

The checkout gets a user-owned, gitignored area:

~~~text
local-assets/
  poses/
  backgrounds/
~~~

A user can copy supported images there. The CLI hashes files, builds a category-aware index, resolves required local references, and makes matched files available to the Remotion render without altering the Story or tracked bundled assets.

This deliberately mirrors the browser model:

~~~text
same YAML ref
    ├── browser → browser-local library
    └── CLI     → local-assets/ folder
~~~

## Implementation order

| Spec | Deliverable | Depends on |
| --- | --- | --- |
| [ASSET-001](./ASSET-001-asset-references-and-resolver.md) | Backward-compatible local asset references and shared readiness boundary | v0.2 |
| [ASSET-002](./ASSET-002-browser-local-asset-storage.md) | Persistent browser-local binary library, hashing, dedup, validation | ASSET-001 |
| [ASSET-003](./ASSET-003-import-and-library-ui.md) | Bundled/My assets UI, import, rename, delete, missing-state UX | ASSET-002 |
| [ASSET-004](./ASSET-004-preview-and-browser-rendering.md) | Player/browser-render resolution of local images | ASSET-001, ASSET-002 |
| [ASSET-005](./ASSET-005-cli-local-assets.md) | Gitignored local folders and CLI resolution/staging | ASSET-001 |
| [ASSET-006](./ASSET-006-persistence-and-production-verification.md) | Backward compatibility, lifecycle coverage, production golden | ASSET-003, ASSET-004, ASSET-005 |

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

Deletion of an asset used by the current Story requires explicit confirmation and may intentionally leave unresolved references.

## Missing-reference behavior

An unavailable local reference remains part of the Story.

The application must:

- preserve the exact reference;
- identify which scenes are affected;
- show a visible missing-asset placeholder/status;
- allow YAML editing/export;
- disable MP4 rendering while any required asset is unresolved;
- offer re-import/replacement;
- automatically resolve when the exact original file is imported again.

No fallback to a bundled pose/background is allowed.

## v0.3 exit criteria

v0.3 is complete when:

- existing v0.2 bundled Stories require no migration;
- PNG/JPEG/WebP pose/background imports up to 25 MiB work;
- user assets remain visually separated from bundled assets;
- original bytes persist in the same browser/origin across reloads;
- exact duplicate bytes do not create duplicate binary storage;
- renaming a local asset does not change YAML references;
- YAML exports contain local references but no image bytes/blob URLs;
- missing references are explicit and block render rather than changing output silently;
- exact-file re-import resolves a missing reference by SHA-256;
- delete-in-use is allowed only after warning;
- Player and browser MP4 rendering work with local pose/background assets;
- the CLI resolves the same refs from `local-assets/`;
- missing CLI assets fail before Remotion with actionable diagnostics;
- production remains static-hosted and backend-free.

## Explicitly out of scope

- cloud asset sync;
- accounts/authentication;
- server uploads;
- remote asset URLs;
- project ZIP/bundle export with image bytes;
- SVG;
- GIF/animated images;
- video assets;
- audio/TTS/music;
- custom fonts;
- props/overlays/effects;
- AI image generation;
- formal character packs / multiple-character domain modeling.
