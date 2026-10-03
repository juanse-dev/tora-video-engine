# ASSET-002 — Browser local asset storage

> Status: **Proposed**

## Goal

Implement a durable browser-local image library for v0.3 custom assets without placing binary data in Story YAML, the existing Story `localStorage` envelope, or Remotion's OPFS render namespace.

## Storage choice

Use **IndexedDB** for the v0.3 browser asset library.

Reasons:

- supports Blob values and structured metadata;
- is same-origin/browser-local;
- supports atomic transactions across metadata/binary records;
- avoids the small/string-only constraints of `localStorage`;
- avoids coupling user assets to Remotion's `__remotion_render:` OPFS lifecycle.

Suggested database:

~~~text
database: tora-video-engine-assets
version: 1

object stores:
  blobs
  thumbnails
  assets
~~~

### blobs store

Key: SHA-256 digest.

Value contains at least:

~~~ts
{
  digest: string;
  blob: Blob;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteSize: number;
  width: number;
  height: number;
}
~~~

### thumbnails store

Key: SHA-256 digest.

Value contains at least:

~~~ts
{
  digest: string;
  blob: Blob;
  mimeType: "image/webp";
  width: number;
  height: number;
}
~~~

The thumbnail is derivative cache data only. It is not part of asset identity and may be regenerated from the original Blob.

v0.3 thumbnail bounds:

~~~ts
MAX_THUMBNAIL_DIMENSION = 256
MAX_MOUNTED_LOCAL_THUMBNAILS = 50
~~~

Thumbnail generation occurs during import from the already-validated original image. The derivative must preserve aspect ratio and fit within 256×256.

The catalog must never use the original full-resolution Blob directly as its thumbnail source.

### assets store

Key: full local asset ref.

Value contains at least:

~~~ts
{
  ref: LocalVisualAssetRef;
  category: "pose" | "background";
  digest: string;
  label: string;
  originalFilename: string;
  createdAt: string;
}
~~~

The binary payload is keyed only by digest so the same bytes can back both a pose entry and a background entry without storing the Blob twice.

## File-size boundary

Define shared resource limits:

~~~ts
MAX_LOCAL_ASSET_BYTES = 25 * 1024 * 1024
MAX_LOCAL_ASSET_DIMENSION = 8192
MAX_LOCAL_ASSET_PIXELS = 50_000_000
~~~

A candidate file must be rejected **before** `arrayBuffer()`, hashing, decoding, or IndexedDB write when:

- `file.size === 0`; or
- `file.size > MAX_LOCAL_ASSET_BYTES`.

The UI must report the source limits explicitly: >0 and ≤25 MiB, ≤8192 px per side, and ≤50 MP.

There is no artificial total-library byte cap in v0.3 beyond browser quota. Browser quota is dynamic and implementation-specific.

## Accepted formats

Only original **static** raster files in these formats are accepted:

- PNG (non-animated);
- JPEG;
- WebP (non-animated).

APNG and animated WebP are rejected.

Do not trust filename extension or `File.type` alone.

The import path must inspect the actual file structure/signature and reject any payload that is not one of the allowed static formats. Filename extension and `File.type` are hints only.

SVG, GIF, AVIF, TIFF, video, audio, and arbitrary binary files are rejected in v0.3 even if a browser could display them.

## Import pipeline

For a selected category + file:

1. reject zero/over-25-MiB size before reading;
2. read the bounded original bytes;
3. identify PNG/JPEG/static-WebP from content and reject APNG/animated WebP;
4. inspect trusted format metadata/header to reject width/height >8192 or total pixels >50 MP before full-resolution decode where practical;
5. compute SHA-256 over those exact original bytes;
6. decode the image successfully and verify positive finite dimensions consistent with the accepted limits;
7. build the category-scoped ref from ASSET-001;
8. generate a bounded ≤256×256 derivative thumbnail;
9. atomically store/reuse/repair binary + thumbnail + metadata;
10. return the existing or newly created local asset entry.

If format/animation/dimension validation, full-image decode, or bounded-thumbnail generation fails, the asset is rejected and no partial database record remains. Import processing is single-file in v0.3, so thumbnail generation never requires concurrent full-resolution decodes.

## Hashing and identity

Use browser Web Crypto SHA-256 over the exact imported bytes.

Hex encoding is lowercase and deterministic.

Do not hash:

- a recompressed image;
- a generated thumbnail;
- filename;
- label;
- MIME string;
- category.

Category is added to the final Story ref separately.

## Deduplication

### Same bytes, same category

Importing the same bytes again as the same category reuses the existing ref/metadata entry, but the import is also a **repair path** for durable backing data.

The freshly validated import must, in one transaction:

- preserve the existing ref;
- preserve the current display label and original creation metadata;
- upsert/replace `blobs[digest]` with the freshly validated original bytes + authoritative MIME/size/dimensions;
- upsert/regenerate `thumbnails[digest]` from those fresh bytes;
- avoid creating a second asset metadata row.

This deliberately repairs cases where metadata exists but the backing Blob/thumbnail is missing or corrupt.

The UI may inform the user that the asset already existed and has been reused/repaired.

### Same bytes, different category

Importing the same bytes once as pose and once as background creates two category-specific metadata entries:

~~~text
local:pose:sha256:<digest>
local:background:sha256:<digest>
~~~

Both point to the same `blobs[digest]` and `thumbnails[digest]`. A fresh valid import may upsert those shared backing records to repair missing/corrupt data without changing either category ref.

## Labels

The initial display label is derived from the original filename for convenience.

The label is mutable metadata.

Renaming:

- updates only the `assets` row;
- never changes digest/ref;
- never rewrites Stories/YAML;
- never duplicates the Blob.

Labels do not need to be unique.

## Delete semantics

Deleting a local asset entry removes that category-specific metadata row.

After deletion, remove the shared original Blob **and thumbnail** only if no remaining asset metadata row references its digest.

This garbage collection must occur in the same logical mutation so a cross-category asset cannot lose its binary/thumbnail while still referenced by another local library entry.

Whether deletion requires a user warning based on Story usage is defined in ASSET-003.

## Atomicity and quota failures

Binary + metadata writes must be atomic from the application's perspective.

If IndexedDB rejects a write because storage is full/unavailable:

- no Story reference is committed automatically;
- no partial asset entry should be presented as available;
- the prior library remains usable;
- bundled-only Stories remain previewable/renderable even if the custom-asset DB is unavailable;
- Stories requiring local refs become explicit asset-unready state;
- show an actionable local-storage warning.

`navigator.storage.estimate()` may be shown as informational preflight but must not be treated as a guarantee.

The app may call `navigator.storage.persist()` as best-effort enhancement, but v0.3 must continue to work when persistence is denied.

## Browser/site-data loss

Browser-local storage is intentionally not a sync mechanism.

If the browser/site data is cleared or evicted:

- the Story remains valid if its YAML/project data survives elsewhere;
- local refs become unresolved;
- ASSET-001/003 missing-asset recovery applies.

Do not attempt hidden cloud backup.

## Cross-tab behavior

IndexedDB transactions are the source of truth for asset-library writes.

Do not reuse the v0.2 Story persistence-writer lock for binary asset storage.

Requirements:

- concurrent duplicate imports remain idempotent by digest/ref key;
- rename must fail cleanly if the entry disappeared before its transaction commits rather than recreating a deleted entry;
- delete must not remove a Blob still referenced by another category entry;
- tabs must invalidate/refresh their library view after another same-origin tab mutates the library.

A same-origin `BroadcastChannel` is the preferred invalidation signal. If a tab misses a signal, re-reading IndexedDB on focus/re-entry must converge to the durable state.

## Runtime source lifecycle

ASSET-001 must already have proven the pinned Remotion browser-render transport gate before this spec is implemented.

Blob URLs are runtime transport only when that ASSET-001 gate accepted `blob:` as the proven transport. If ASSET-001 chose another ephemeral transport, use that transport while preserving every persistence invariant below.

When ASSET-001 accepts `blob:`, a browser asset source manager may cache:

~~~text
digest → object URL
~~~

For any other ASSET-001-proven transport, keep an equivalent bounded `digest → ephemeral runtime source` cache.

but:

- URLs are recreated from IndexedDB after reload;
- URLs are never written to YAML/localStorage/IndexedDB metadata;
- a URL in active Player/render use is not revoked prematurely;
- URLs are revoked when no longer needed;
- deleting the durable DB entry does not invalidate a render that already holds its own Blob/object-URL snapshot.

ASSET-004 defines the Player/render lifecycle around these URLs.

## Thumbnail behavior

The catalog uses only the bounded derivative thumbnails generated during import.

Requirements:

- max derivative dimensions: 256×256 while preserving aspect ratio;
- thumbnail identity/cache key: original SHA-256 digest;
- thumbnail bytes never affect Story refs or dedup identity;
- original bytes remain authoritative;
- SHA-256 continues to use original bytes;
- catalog cards never decode the original full-resolution Blob merely to show a thumbnail;
- at most 50 local thumbnail cards are mounted/decoded at once; use windowing/pagination rather than mounting an unbounded library grid;
- object/runtime URLs for off-window thumbnail cards are released promptly;
- deleting the final asset entry for a digest removes its thumbnail together with the original Blob.

This keeps catalog memory bounded even when the library contains many images near the per-file limit.

## Tests

Minimum coverage:

- rejects zero-byte asset before hash/decode;
- rejects >25 MiB before hash/decode/storage;
- rejects width/height >8192 and total pixels >50 MP before full decode where practical;
- static PNG/JPEG/WebP accepted;
- APNG and animated WebP rejected;
- disallowed/mislabeled content rejected;
- failed image decode leaves no durable entry;
- SHA-256 is over original bytes;
- same bytes + same category reuse one ref and upsert/repair the backing Blob/thumbnail without changing label/created metadata;
- same bytes + different categories reuse Blob/thumbnail but create two refs;
- rename preserves ref/hash;
- deleting one category keeps shared Blob/thumbnail while another category references it;
- deleting final metadata removes unreferenced Blob/thumbnail;
- metadata-present + Blob/thumbnail-missing/corrupt + exact-file reimport restores usable backing data without Story mutation;
- quota/storage failure leaves prior library intact;
- reload rebuilds library metadata from IndexedDB;
- ephemeral runtime sources (including object URLs when used) are not persisted;
- same-origin mutation invalidation refreshes stale library views.

## Acceptance criteria

- a valid static PNG/JPEG/WebP satisfying ≤25 MiB, ≤8192 px per side, and ≤50 MP can become a durable local library entry;
- exact duplicate bytes are deduplicated and duplicate reimport repairs missing/corrupt backing data;
- original source Blob is preserved byte-for-byte;
- labels are safely mutable;
- binary storage remains separate from Story persistence and Remotion OPFS;
- storage loss degrades into missing refs rather than corrupting Story data.

## Out of scope

- cloud backup/sync;
- arbitrary total storage guarantees;
- server upload;
- remote asset URLs;
- transcoding/recompression;
- automatic image optimization;
- non-raster formats.

## Done when

The browser can persist, list, rename, deduplicate, resolve, and delete bounded static local raster assets reliably without changing the Story schema or storing image bytes in Story persistence.
