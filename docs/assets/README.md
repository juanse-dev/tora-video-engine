# Local Custom Assets roadmap (v0.3)

This directory is the implementation plan for **Tora Video Engine v0.3 — Local Custom Assets**.

Umbrella issue: [#18 — v0.3 — Local Custom Assets](https://github.com/juanse-dev/tora-video-engine/issues/18)

The specs are written to be executed task-by-task by an implementing model or developer **without reopening design decisions**. Every open question from earlier drafts is resolved in [Decisions](#decisions). If something is genuinely ambiguous during implementation, stop and ask; do not invent a new mechanism.

## Product promise

A user can import a static PNG, JPEG, or static WebP image as a **pose** or a **background**, reuse it across Stories in the same browser/origin, preview and render with it, and keep the image entirely local to that browser/computer. A YAML exported from the browser renders from a local checkout after the user copies the same image files into `local-assets/`.

The browser library is **not synchronized**. A different browser, profile, device, origin (production vs Deploy Preview vs localhost), or cleared site data means the assets are unavailable. The Story keeps its references and shows an explicit missing state until the exact same files are re-imported or replacements are chosen.

## Invariants

These are referenced from the specs as `INV-n`. They are stated once, here.

| ID | Invariant |
| --- | --- |
| INV-1 | Story data references assets; it never contains image bytes, data URLs, blob URLs, or filesystem paths. |
| INV-2 | Bundled and local assets are separate inventories. Bundled values (`formal`, `office`, …) stay valid and unchanged. |
| INV-3 | Local identity is `category + SHA-256(original bytes)`. Labels and filenames are metadata, never identity. |
| INV-4 | A missing/corrupt local asset is an **asset-readiness** state, never a schema error. The Story stays parseable, editable, persistable and exportable. |
| INV-5 | Missing assets never silently fall back to another image. Preview shows a placeholder; MP4 render is blocked. |
| INV-6 | Original bytes are stored and rendered byte-for-byte. No recompression or resizing of originals (thumbnails are separate derivatives). |
| INV-7 | Every source image is bounded **before** expensive work: bytes `> 0` and `≤ 25 MiB`; width and height `≤ 8192`; `width × height ≤ 50 000 000`; animated PNG/WebP rejected. |
| INV-8 | Browser assets live only in IndexedDB on the user's device. No upload, backend, account, sync or remote URL. |
| INV-9 | CLI assets live only in the gitignored `local-assets/` folder and are detected by content, not by extension. |
| INV-10 | Rendering semantics are unchanged: poses use `objectFit: contain`, backgrounds use `objectFit: cover`. |
| INV-11 | A lookup key is the only identity authority. A stored value can never redirect a lookup to another ref, category, or digest. |
| INV-12 | Bytes are only used at runtime after their SHA-256, size, format and dimensions are verified against the requested ref and stored metadata in the current page session. |

## Shared constants

Define each constant exactly once, in the file listed. Import it everywhere else.

| Constant | Value | Defined in |
| --- | --- | --- |
| `MAX_LOCAL_ASSET_BYTES` | `25 * 1024 * 1024` | `src/localAssets/limits.ts` |
| `MAX_LOCAL_ASSET_DIMENSION` | `8192` | `src/localAssets/limits.ts` |
| `MAX_LOCAL_ASSET_PIXELS` | `50_000_000` | `src/localAssets/limits.ts` |
| `MAX_BROWSER_STORY_LOCAL_ASSET_REFS` | `64` | `src/localAssets/limits.ts` |
| `MAX_BROWSER_STORY_LOCAL_ASSET_BYTES` | `256 * 1024 * 1024` | `src/localAssets/limits.ts` |
| `MAX_BROWSER_STORY_LOCAL_ASSET_PIXELS` | `200_000_000` | `src/localAssets/limits.ts` |
| `MAX_THUMBNAIL_DIMENSION` | `256` | `src/web/assetLibrary/constants.ts` |
| `MAX_THUMBNAIL_BYTES` | `512 * 1024` | `src/web/assetLibrary/constants.ts` |
| `LOCAL_ASSET_PAGE_SIZE` | `50` | `src/web/assetLibrary/constants.ts` |
| `MAX_LOCAL_ASSET_LABEL_LENGTH` | `80` (code points, after trim) | `src/web/assetLibrary/constants.ts` |
| `ASSET_DB_NAME` | `"tora-video-engine-assets"` | `src/web/assetLibrary/constants.ts` |
| `ASSET_DB_VERSION` | `1` | `src/web/assetLibrary/constants.ts` |
| `ASSET_LIBRARY_LOCK` | `"tora-video-engine:asset-library"` | `src/web/assetLibrary/constants.ts` |
| `ASSET_LIBRARY_CHANNEL` | `"tora-video-engine:asset-library"` | `src/web/assetLibrary/constants.ts` |
| `LOCAL_ASSETS_ROOT` | `"local-assets"` | `scripts/localAssets.ts` |
| `STAGED_LOCAL_ASSETS_DIR` | `"__local-assets"` | `src/localAssets/sources.ts` |

Existing constants that v0.3 reuses unchanged: `WEB_RENDER_LOCK_NAME` (`src/web/browserRender.ts`), `PERSISTENCE_WRITER_LOCK` and `PERSISTENCE_STORAGE_KEY` (`src/web/persistence.ts`).

## Stable reference grammar

Bundled refs keep their current values:

~~~yaml
pose: formal
background: office
~~~

Local refs:

~~~yaml
pose: local:pose:sha256:<64 lowercase hex>
background: local:background:sha256:<64 lowercase hex>
~~~

Regex (exact, anchored): `^local:(pose|background):sha256:[0-9a-f]{64}$`.

The category is part of the ref, so a pose ref can never satisfy a background field. The same bytes can be registered in both categories; both refs share one stored payload.

## Decisions

These are closed. Implement them as written.

| ID | Decision | Rationale / evidence |
| --- | --- | --- |
| D-1 | Browser runtime transport is **`blob:` object URLs** passed through the composition props. | Spike on 2026-10-08 with pinned `@remotion/web-renderer@4.0.529`, `allowHtmlInCanvas: false`, `outputTarget: "web-fs"`, system Chrome: a `<Img pauseWhenLoading src={blobUrl}>` rendered correctly into the MP4 for PNG, JPEG and WebP, including a 6000×8000 PNG (~600 ms for 30 frames). Frames were verified by extracting them with ffmpeg. ASSET-004 turns the spike into a committed regression test (MP4 golden). |
| D-2 | CLI staging uses a **temporary public directory** passed with Remotion's `--public-dir`. It contains a copy of the repository `public/` plus `__local-assets/<category>/<digest>.<ext>`. | Spike on 2026-10-08: `remotion still … --public-dir=<tmp>` used images from the temporary directory. |
| D-3 | Without Web Locks (`navigator.locks?.request` missing), **My assets is disabled**: the asset database is never opened, all local refs are `unavailable`, and import is hidden behind a capability message. | v0.2 already treats browser MP4 render as unsupported and persistence as session-only without Web Locks. A read-only degraded mode would add a lot of protocol for browsers that don't exist in practice. |
| D-4 | Image validation is a **shared pure-TypeScript header inspector** (`src/localAssets/imageInspection.ts`) used by both browser and CLI. The browser additionally decodes with `createImageBitmap`. The CLI does **not** decode; an undecodable image that passes header inspection makes the Remotion render fail with a non-zero exit. | Node has no image decoder and v0.3 does not add a native dependency such as `sharp`. One parser guarantees identical accept/reject behavior in browser and CLI. |
| D-5 | Storage logic is written against a small **`AssetLibraryStore` interface**. Node unit tests use an in-memory fake that counts reads. The IndexedDB adapter is thin and is tested with Playwright. | Node has no IndexedDB, and the repo does not use `fake-indexeddb`. |
| D-6 | Thumbnails are encoded as WebP; if the browser returns another type (Safari returns PNG), store whatever `convertToBlob` actually produced and record its MIME type. | Safari cannot encode WebP from canvas. |
| D-7 | The composition contract (`localAssetSources` prop + missing placeholder) is part of **ASSET-001**, so the CLI (ASSET-005) and browser (ASSET-004) can be built independently. | Earlier drafts put it in ASSET-004 while ASSET-005 also needed it. |
| D-8 | Integrity hashing is sequential (one payload at a time). Verified results are cached per page session and invalidated by mutations. | Bounds memory to one ≤25 MiB payload at a time. |
| D-9 | When a stored value disagrees with its key (INV-11) the record is `corrupt`. The UI treats `corrupt` like `missing` (same placeholder, same repair path), but diagnostics keep the reason. | One recovery UX, precise diagnostics. |
| D-10 | Over-budget is decided **only** from metadata (`payloadMeta`) before any Blob read. Because verification requires metadata to equal the real bytes, there is no "over budget after verification" path. | Removes an ambiguous second branch from earlier drafts. |
| D-11 | Catalog pagination is **Previous / Next** buttons per category, 50 rows per page, ordered by primary key (`local:<category>:sha256:<digest>`). No secondary indexes. | Simple, bounded, deterministic. Order is by hash, not by date or label; that is acceptable for v0.3. |
| D-12 | Default label = original filename without its last extension, trimmed, cut to `MAX_LOCAL_ASSET_LABEL_LENGTH` code points; if empty, `"Untitled pose"` / `"Untitled background"`. | Concrete rule instead of "safe import defaults". |

## Architecture

~~~mermaid
flowchart LR
    Y[Story / YAML] --> R[Asset refs]
    R --> B[Bundled catalog<br/>src/assets.ts]
    R --> L[Local refs]

    subgraph Browser
      L --> DB[(IndexedDB<br/>tora-video-engine-assets)]
      DB --> V[Integrity verifier]
      V --> U[blob: URLs]
    end

    subgraph CLI
      L --> F[local-assets/ scan]
      F --> S[temp public dir<br/>__local-assets/]
    end

    B --> C[Shared composition<br/>ToraVideo → Scene → Tora / Background]
    U -- localAssetSources --> C
    S -- localAssetSources --> C
~~~

The Story is shared. Bytes are environment-specific. Components never read IndexedDB or the filesystem; they only read `localAssetSources` from props.

### Browser storage layout

| Store | Key | Value | Notes |
| --- | --- | --- | --- |
| `assets` | full local ref | `{label, originalFilename, createdAt}` | One row per category + digest. |
| `payloadMeta` | digest | `{mimeType, byteSize, width, height}` | Light metadata for budget and readiness. Never contains bytes. |
| `blobs` | digest | `{blob}` | Original bytes. Read only for integrity verification and runtime sources. |
| `thumbnails` | digest | `{blob, mimeType, width, height}` | Derivative, ≤256×256. |

### Readiness pipeline (browser)

~~~text
Story schema ─▶ browser Story policy ─▶ local asset readiness ─▶ Player / Render eligibility
                (existing, v0.2)         (new, ASSET-001/004)
~~~

Readiness of one local ref is one of: `ready` · `missing` · `corrupt` · `unavailable` (library disabled or failed to open) · `pending` (still resolving). The whole Story can additionally be `over-budget`.

## Execution order

| Order | Spec | Deliverable | Depends on |
| --- | --- | --- | --- |
| 1 | [ASSET-001](./ASSET-001-asset-references-and-resolver.md) | Ref grammar, schema/types, persistence v2, composition contract, readiness/budget functions | v0.2 |
| 2 | [ASSET-002](./ASSET-002-browser-local-asset-storage.md) | Image inspection, hashing, storage interface + IndexedDB adapter, integrity verifier | ASSET-001 |
| 3a | [ASSET-005](./ASSET-005-cli-local-assets.md) | CLI scanner, staging, `npm run assets` | ASSET-001, ASSET-002 tasks 1–2 (fixtures, image inspection, hashing) |
| 3b | [ASSET-004](./ASSET-004-preview-and-browser-rendering.md) | Player + browser render with local sources, render lock hand-off, blob transport MP4 golden | ASSET-001, ASSET-002 |
| 4 | [ASSET-003](./ASSET-003-import-and-library-ui.md) | My assets UI: import, rename, delete, missing-asset recovery | ASSET-002, ASSET-004 |
| 5 | [ASSET-006](./ASSET-006-persistence-and-production-verification.md) | Cross-cutting end-to-end tests, then the human production gate | all |

3a and 3b are independent and can run in parallel.

Each spec is split into numbered tasks. **One task ≈ one PR-sized change** that leaves `npm test`, `npm run lint`, and the existing browser suites green.

## Working conventions

Follow the existing repository idioms:

- TypeScript sources import siblings with explicit `.ts` / `.tsx` extensions (see `src/story/schema.ts`).
- Node unit tests live in `tests/*.test.mjs`, use `node:test` + `node:assert/strict`, and import `.ts` directly (run with `npm test`).
- Browser tests live in `tests/browser/*.spec.mjs` and run against the production build (`npm run web:build`, then `npm run test:browser`). The MP4 golden uses `playwright.browser-render.config.mjs` with system Chrome.
- Inject browser APIs (`navigator.locks`, `indexedDB`, `crypto.subtle`, `createImageBitmap`, `BroadcastChannel`) through optional dependency parameters, the same way `src/web/browserRender.ts` injects `getLocks`. This keeps logic unit-testable in Node.
- Write the failing test first, then the implementation.
- Before finishing a task run: `npm test`, `npm run lint`, `npm run web:build`, `npm run test:browser`. Run the browser-render golden for tasks that touch rendering.
- Do not modify the v0.2 specs in `docs/web/` or `docs/mvp/`.
- When a task is done, tick it in the spec's task list and update the spec's `Status` line.

**Frame sampling tip:** to check pixels in a rendered MP4, reuse the decoding helpers in `tests/browser/browser-render-golden.spec.mjs` and always include a positive control (for example, a solid color region), because a wrong seek/decode returns all-black frames that look like a failure of the feature under test.

## v0.3 exit criteria

v0.3 is complete when every spec's tasks are ticked and the [ASSET-006 completion checklist](./ASSET-006-persistence-and-production-verification.md#completion-checklist), including the human production gate, passes.

## Out of scope

Cloud sync, accounts, server uploads, remote URLs, project archives containing bytes, SVG, GIF, APNG/animated WebP, video, audio/TTS/music, custom fonts, props/overlays/effects, AI image generation, multiple-character modeling, a read-only asset library mode without Web Locks, Remotion Studio support for `local-assets/`, and a "clear entire library" action.
