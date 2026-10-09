# ASSET-002 — Image inspection, hashing and browser asset library

> Status: **Proposed**
>
> Depends on: ASSET-001. Read [README](./README.md) first (`INV-n`, constants, `D-n`).

## Goal

Build the browser-local asset library that ASSET-003 (UI) and ASSET-004 (Player/render) consume: content validation, SHA-256 identity, an IndexedDB store with atomic import/rename/delete, cross-tab coordination, and integrity verification before bytes are used. Also build the shared image inspector and test fixtures that the CLI (ASSET-005) reuses.

No UI in this spec.

## Decisions specific to this spec

- Image validation is header-based and shared with the CLI (D-4). The browser also fully decodes once at import time with `createImageBitmap`.
- All library logic is written against the `AssetLibraryStore` interface (D-5). Node tests use an in-memory fake; the IndexedDB adapter is tested in a browser harness.
- Without Web Locks the library is `disabled` and the database is never opened (D-3).
- Only one import runs at a time per tab. The UI (ASSET-003) disables import buttons while one is in progress.

## Files

| Action | Path | Purpose |
| --- | --- | --- |
| create | `src/localAssets/imageInspection.ts` | Pure header inspector for PNG/JPEG/WebP (shared with CLI). |
| create | `src/localAssets/hash.ts` | `sha256Hex()` over bytes via Web Crypto (works in browser and Node 22). |
| create | `src/web/assetLibrary/constants.ts` | Library constants from the README table. |
| create | `src/web/assetLibrary/records.ts` | Record types + decoders that enforce INV-11. |
| create | `src/web/assetLibrary/store.ts` | `AssetLibraryStore` interface and mutation types. |
| create | `src/web/assetLibrary/indexedDbStore.ts` | IndexedDB implementation of the store. |
| create | `src/web/assetLibrary/coordination.ts` | Web Lock helpers, BroadcastChannel messages, library status. |
| create | `src/web/assetLibrary/importAsset.ts` | Import pipeline: prepare (no lock) + commit (exclusive lock). |
| create | `src/web/assetLibrary/library.ts` | Rename, delete, paging, counting, entry lookup. |
| create | `src/web/assetLibrary/integrity.ts` | Sequential payload verifier + per-session cache. |
| create | `src/web/assetLibrary/thumbnails.ts` | Browser-only thumbnail generation. |
| create | `tests/helpers/memoryAssetStore.mjs` | In-memory `AssetLibraryStore` with read counters and failure injection. |
| create | `tests/helpers/imageBytes.mjs` | Builders for crafted PNG/JPEG/WebP headers (APNG, animated WebP, huge dimensions, truncated). |
| create | `tests/fixtures/local-assets/` | Real decodable fixtures (see Task 1). |
| create | `tests/harness/asset-library.html` + `.ts` | Dev-server page exposing the IndexedDB store to Playwright. |
| create | `playwright.harness.config.mjs` | `testDir: "tests/harness"`; runs harness specs against the `vite` dev server on port 4174 (page URL `/tests/harness/asset-library.html`). |
| modify | `package.json` | Add `"test:harness": "playwright test --config=playwright.harness.config.mjs"`. |
| modify | `.github/workflows/ci.yml` | Run `npm run test:harness` after `npm run test:browser`. |
| create | `tests/image-inspection.test.mjs`, `tests/asset-library.test.mjs`, `tests/asset-integrity.test.mjs`, `tests/harness/asset-library-indexeddb.spec.mjs` | Tests. Harness specs live outside `tests/browser/` so the default `playwright.config.mjs` (production preview) never runs them. |

## 1. Image inspection (`src/localAssets/imageInspection.ts`)

~~~ts
export type InspectedImage = {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
};

export type ImageRejection =
  | "empty"
  | "too-large"            // > MAX_LOCAL_ASSET_BYTES
  | "unsupported-format"   // not PNG/JPEG/WebP by signature (GIF, SVG, AVIF, BMP, text…)
  | "animated"             // APNG or animated WebP
  | "dimensions-too-large" // width or height > 8192
  | "too-many-pixels"      // width*height > 50 000 000
  | "malformed";           // right signature but truncated/inconsistent header, or 0 dimension

export const checkLocalAssetByteSize = (
  byteSize: number,
): {ok: true} | {ok: false; reason: "empty" | "too-large"};

export const inspectImageBytes = (
  bytes: Uint8Array,
): {ok: true; image: InspectedImage} | {ok: false; reason: ImageRejection};

export const describeImageRejection = (reason: ImageRejection): string;
~~~

`inspectImageBytes` first applies `checkLocalAssetByteSize(bytes.length)`, then detects format **only from bytes** (never extension or MIME), then applies dimension/pixel limits. All reads are bounds-checked; reading past the end returns `malformed`, never throws.

Format rules:

- **PNG** — signature `89 50 4E 47 0D 0A 1A 0A`. First chunk must be `IHDR` with length 13; width = big-endian uint32 at byte 16, height at byte 20. Walk chunks (`length` uint32 BE, 4-byte type, data, 4-byte CRC) until the first `IDAT`. If an `acTL` chunk appears before `IDAT` → `animated`. No `IDAT` before end of data → `malformed`. CRCs are not verified.
- **JPEG** — starts with `FF D8`. Scan segments: skip `FF` fill bytes; markers `D0`–`D7`, `01` have no length; other markers have a 2-byte BE length that includes itself. The first SOF marker (`C0`–`C3`, `C5`–`C7`, `C9`–`CB`, `CD`–`CF`) gives height (uint16 BE at segment offset 3) and width (offset 5). Reaching `DA` (SOS) or `D9` (EOI) before an SOF → `malformed`. Dimensions are the raw stored dimensions (EXIF orientation is ignored for limits and metadata).
- **WebP** — bytes 0–3 `RIFF`, 8–11 `WEBP`. First chunk at offset 12:
  - `VP8 ` (lossy): frame data starts at chunk offset 8; bytes 3–5 of frame data must be `9D 01 2A`; width = `uint16 LE at frame+6 & 0x3FFF`, height = `uint16 LE at frame+8 & 0x3FFF`.
  - `VP8L` (lossless): byte at chunk data offset 0 must be `0x2F`; read the next 4 bytes as uint32 LE `b`; width = `(b & 0x3FFF) + 1`, height = `((b >> 14) & 0x3FFF) + 1`.
  - `VP8X` (extended): flags byte at data offset 0; if `flags & 0x02` (animation) → `animated`; width = 24-bit LE at data offset 4, plus 1; height = 24-bit LE at offset 7, plus 1. Also scan the remaining top-level chunks: any `ANIM` or `ANMF` → `animated`.
  - anything else → `malformed`.
- Everything else → `unsupported-format`.

`describeImageRejection` returns user-facing sentences, for example: `"The file is larger than 25 MiB."`, `"Only static PNG, JPEG and WebP images are supported."`, `"Animated images are not supported."`, `"Images must be at most 8192 pixels wide and tall."`, `"Images must be at most 50 megapixels."`, `"The file is empty."`, `"The image file is damaged or incomplete."`.

## 2. Hashing (`src/localAssets/hash.ts`)

~~~ts
export const sha256Hex = async (
  bytes: Uint8Array,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string>; // 64 lowercase hex chars
~~~

Hash exactly the original file bytes (never a thumbnail, filename, label, MIME or category). Node 22 exposes `globalThis.crypto.subtle`, so the CLI uses this same function.

## 3. Records and decoders (`src/web/assetLibrary/records.ts`)

~~~ts
export type AssetRow = {label: string; originalFilename: string; createdAt: string}; // ISO 8601
export type ThumbnailRecord = {blob: Blob; mimeType: string; width: number; height: number};
// PayloadMetadata comes from src/localAssets/readiness.ts

export type Decoded<T> =
  | {status: "present"; value: T}
  | {status: "absent"}
  | {status: "corrupt"; reason: string};

export const decodeAssetRow = (key: LocalAssetRef, value: unknown): Decoded<AssetRow>;
export const decodePayloadMeta = (digest: string, value: unknown): Decoded<PayloadMetadata>;
export const decodeBlobRecord = (digest: string, value: unknown): Decoded<Blob>;
export const decodeThumbnail = (digest: string, value: unknown): Decoded<ThumbnailRecord>;
~~~

Decoder rules (INV-11):

- `undefined` → `absent`.
- Required fields with the wrong type, non-finite or non-positive numbers, unknown `mimeType` → `corrupt`.
- Thumbnails are bounded on **read**, not only when generated: `decodeThumbnail` returns `corrupt` unless `width` and `height` are ≤ `MAX_THUMBNAIL_DIMENSION` and `blob.size` ≤ `MAX_THUMBNAIL_BYTES` (`512 * 1024`, add it to `src/web/assetLibrary/constants.ts`). The catalog card additionally sets fixed CSS dimensions on the `<img>` and, after load, treats `naturalWidth`/`naturalHeight` > 256 as corrupt (hide the image, show the neutral box). Exact-file reimport regenerates the thumbnail.
- If the value contains a redundant identity field (`ref`, `category`, `digest`), it must equal what the key implies; otherwise `corrupt`. A mismatching field is never used to look anything else up.
- New writes never include identity fields; the key is the identity.

## 4. Store interface (`src/web/assetLibrary/store.ts`)

~~~ts
export type AssetPageCursor = {after?: LocalAssetRef; before?: LocalAssetRef};

export type AssetLibraryMutation =
  | {
      kind: "import";
      ref: LocalAssetRef;
      defaultLabel: string;
      originalFilename: string;
      createdAt: string;
      payloadMeta: PayloadMetadata;
      blob: Blob;
      thumbnail: ThumbnailRecord;
    }
  | {kind: "rename"; ref: LocalAssetRef; label: string}
  | {kind: "delete"; ref: LocalAssetRef};

export type AssetLibraryMutationResult =
  | {kind: "imported"; ref: LocalAssetRef; created: boolean} // created=false: existing row reused/repaired
  | {kind: "renamed"; ref: LocalAssetRef}
  | {kind: "deleted"; ref: LocalAssetRef; payloadRemoved: boolean}
  | {kind: "not-found"; ref: LocalAssetRef}; // rename/delete of a row that no longer exists

export interface AssetLibraryStore {
  getAssetRow(ref: LocalAssetRef): Promise<Decoded<AssetRow>>;
  getPayloadMeta(digest: string): Promise<Decoded<PayloadMetadata>>;
  getBlob(digest: string): Promise<Decoded<Blob>>;
  getThumbnail(digest: string): Promise<Decoded<ThumbnailRecord>>;
  /** Ordered by primary key inside the category prefix; at most `limit` rows. */
  listAssets(
    category: LocalAssetCategory,
    cursor: AssetPageCursor,
    limit: number,
  ): Promise<Array<{ref: LocalAssetRef; row: Decoded<AssetRow>}>>;
  countAssets(category: LocalAssetCategory): Promise<number>;
  /** Applies one mutation in ONE read-write transaction over all four stores. */
  apply(mutation: AssetLibraryMutation): Promise<AssetLibraryMutationResult>;
  close(): void;
}
~~~

Mutation semantics (all inside one transaction; any error aborts everything):

- **import** — read `assets[ref]`. If it decodes `present`, keep its `label` and `createdAt`; otherwise use `defaultLabel` and `createdAt` from the mutation. Always write `originalFilename` from the mutation, and overwrite `payloadMeta[digest]`, `blobs[digest]`, `thumbnails[digest]` with the fresh values. This repairs any missing/corrupt backing data. `created` is `true` only if the row was `absent`. The existing row is read **inside this transaction** (after the exclusive lock is held), never captured during the unlocked prepare step, so a rename committed by another tab while this tab was hashing is preserved.
- **rename** — if `assets[ref]` is absent → `not-found` (never recreate). Otherwise write the row with the new label, preserving the other fields (if the row was corrupt, write `originalFilename: ""` and `createdAt` = now).
- **delete** — if absent → `not-found`. Delete `assets[ref]`. Derive the digest **from `ref`**, build the other category's ref; if `assets[otherRef]` does not exist, delete `payloadMeta`, `blobs` and `thumbnails` for that digest (`payloadRemoved: true`).

## 5. IndexedDB adapter (`src/web/assetLibrary/indexedDbStore.ts`)

~~~ts
export const openIndexedDbAssetStore = async (deps?: {
  indexedDB?: IDBFactory;
  locks?: LockManager;
}): Promise<AssetLibraryStore>;
~~~

- Database `ASSET_DB_NAME`, version `ASSET_DB_VERSION`; object stores `assets`, `payloadMeta`, `blobs`, `thumbnails`, all with out-of-line keys. No indexes.
- The `indexedDB.open` call that may create/upgrade the database runs while holding `ASSET_LIBRARY_LOCK` in **exclusive** mode. `onupgradeneeded` only creates missing stores (v1).
- `onversionchange` → close the connection immediately (so another tab's upgrade is never held up by this tab); later calls reject with an error whose message says the library was upgraded in another tab and the page must be reloaded.
- `onblocked` on our own open (another tab still holds an older connection that did not close) → wait at most 5 seconds; if the open has not succeeded, abort it, release the exclusive lock, and return `unavailable` with `"Close other Tora tabs to finish updating My assets, then reload."`. v0.3 only ever opens version 1, so this path matters for future schema versions; implement and test it now so v0.3 tabs behave correctly when a later version upgrades.
- `listAssets` uses `IDBKeyRange.bound(prefix, prefix + "\uffff")` (type the six-character escape `\uffff` in code), narrowed by the cursor with open bounds; `openCursor` with direction `next` (`after`) or `prev` (`before`, results reversed back to ascending); stops after `limit` rows. Never `getAll()` over `assets`.
- Every primary key read from a cursor must pass `isLocalAssetRef` **and** belong to the requested category. Keys that fail are skipped (never returned as a `LocalAssetRef`) and do not count toward `limit`. `countAssets` therefore counts with `openKeyCursor` over the range, skipping non-canonical keys, instead of `store.count(range)`. App writes can never create such keys because every write key comes from `buildLocalAssetRef`.
- Map `QuotaExceededError` (or a transaction aborted with it) to `LocalAssetLibraryError` code `storage-full`; other failures to `storage-error`.

## 6. Coordination (`src/web/assetLibrary/coordination.ts`)

~~~ts
export type AssetLibraryStatus =
  | {kind: "disabled"; message: string}    // no Web Locks (D-3)
  | {kind: "unavailable"; message: string} // no indexedDB, or open failed
  | {kind: "ready"; store: AssetLibraryStore};

export const openAssetLibrary = async (deps?: {
  locks?: LockManager;
  indexedDB?: IDBFactory;
}): Promise<AssetLibraryStatus>;

export const withAssetLibraryLock = <T>(
  locks: LockManager,
  mode: "exclusive" | "shared",
  task: () => Promise<T>,
): Promise<T>;

export type AssetLibraryMessage = {
  type: "asset-library-changed";
  refs: LocalAssetRef[];
  digests: string[];
};

export const createAssetLibraryChannel = (
  onMessage: (message: AssetLibraryMessage) => void,
  deps?: {BroadcastChannel?: typeof BroadcastChannel},
): {post(message: AssetLibraryMessage): void; close(): void};
~~~

Rules:

- `openAssetLibrary`: if `navigator.locks?.request` is missing → `disabled` with message `"My assets needs a browser with Web Locks support. Local assets in this Story can't be shown or rendered here."`. Do not call `indexedDB.open`. If `indexedDB` is missing or opening fails → `unavailable` with an actionable message. Bundled-only Stories are unaffected by either.
- Every `store.apply(...)` call from the app is wrapped in `withAssetLibraryLock(locks, "exclusive", …)`. Heavy work (reading, hashing, decoding, thumbnail) happens **before** requesting the lock.
- After a successful mutation, post an `asset-library-changed` message naming the affected refs and digests. The receiving tab invalidates the integrity cache for those digests and refreshes any library views. Also refresh on `window` `focus`. BroadcastChannel is a best-effort refresh signal only, never a synchronization barrier (ASSET-004 uses the shared lock for that).
- Call `navigator.storage.persist()` once, best effort, after the first successful import in a session. Ignore the result.

## 7. Import pipeline (`src/web/assetLibrary/importAsset.ts`)

~~~ts
export type ImportPhase = "reading" | "validating" | "hashing" | "storing";

export type PreparedLocalAssetImport = {
  ref: LocalAssetRef;
  defaultLabel: string;
  originalFilename: string;
  payloadMeta: PayloadMetadata;
  blob: Blob;
  thumbnail: ThumbnailRecord;
};

export const prepareLocalAssetImport = async (
  file: File,
  category: LocalAssetCategory,
  deps: {
    subtle?: SubtleCrypto;
    decode?: (blob: Blob) => Promise<{width: number; height: number; close(): void}>;
    makeThumbnail?: (blob: Blob, width: number, height: number) => Promise<ThumbnailRecord>;
    onPhase?: (phase: ImportPhase) => void;
  },
): Promise<PreparedLocalAssetImport>; // throws LocalAssetImportError

/** Commits an already-prepared import under the exclusive lock and posts the change message. */
export const commitPreparedLocalAssetImport = async (
  prepared: PreparedLocalAssetImport,
  library: {store: AssetLibraryStore; locks: LockManager; channel: {post(m: AssetLibraryMessage): void}},
): Promise<{ref: LocalAssetRef; created: boolean}>;

/** prepareLocalAssetImport + onPhase("storing") + commitPreparedLocalAssetImport. */
export const importLocalAsset = async (
  file: File,
  category: LocalAssetCategory,
  library: {store: AssetLibraryStore; locks: LockManager; channel: {post(m: AssetLibraryMessage): void}},
  deps?: Parameters<typeof prepareLocalAssetImport>[2],
): Promise<{ref: LocalAssetRef; created: boolean}>;

export class LocalAssetImportError extends Error {
  code: ImageRejection | "decode-failed" | "thumbnail-failed" | "storage-full" | "storage-error";
}
~~~

`prepareLocalAssetImport` steps, in order (stop at the first failure; nothing is written):

1. `checkLocalAssetByteSize(file.size)` — before reading any bytes.
2. `onPhase("reading")`; `bytes = new Uint8Array(await file.arrayBuffer())`.
3. `onPhase("validating")`; `inspectImageBytes(bytes)`.
4. `onPhase("hashing")`; `digest = await sha256Hex(bytes)`; `ref = buildLocalAssetRef(category, digest)`.
5. Decode: default `createImageBitmap(blob)`. The decoded size must equal the inspected header size, or the same size swapped (browsers apply JPEG EXIF rotation and there is no option to disable it); otherwise `decode-failed`. Close the bitmap.
6. Thumbnail (default implementation in `thumbnails.ts`): decode with default orientation, scale to fit within 256×256 keeping aspect ratio (never upscale; each side ≥ 1), draw on an `OffscreenCanvas`, `convertToBlob({type: "image/webp", quality: 0.8})`; record the MIME type the browser actually produced (D-6). Failure → `thumbnail-failed`.
7. `blob = new Blob([bytes], {type: image.mimeType})`; `payloadMeta = {mimeType, byteSize: bytes.length, width, height}`; `defaultLabel` per D-12.

`commitPreparedLocalAssetImport` applies the `import` mutation under the exclusive lock, posts the change message, and returns. `importLocalAsset` is prepare → `onPhase("storing")` → commit. ASSET-003 calls prepare and commit separately when it must inspect the ref before writing (matching-file repair). Quota and transaction errors become `storage-full` / `storage-error`. The Story is never modified here; ASSET-003 decides whether to apply the ref.

## 8. Library operations (`src/web/assetLibrary/library.ts`)

~~~ts
export type LocalAssetEntry = {
  ref: LocalAssetRef;
  category: LocalAssetCategory;
  digest: string;
  row: Decoded<AssetRow>; // corrupt rows are listed so they can be repaired/deleted, never applied
};

export const listLocalAssetPage: (store, category, cursor) => Promise<{
  entries: LocalAssetEntry[];
  hasPrevious: boolean;
  hasNext: boolean;
}>; // page size LOCAL_ASSET_PAGE_SIZE; fetch limit+1 rows to compute hasNext/hasPrevious
export const countLocalAssets: (store, category) => Promise<number>;
export const renameLocalAsset: (library, ref, label) => Promise<AssetLibraryMutationResult>;
export const deleteLocalAsset: (library, ref) => Promise<AssetLibraryMutationResult>;
export const normalizeLocalAssetLabel: (label: string) =>
  {ok: true; label: string} | {ok: false; message: string};
~~~

Label rule: trim; must be non-empty; at most `MAX_LOCAL_ASSET_LABEL_LENGTH` code points. Labels need not be unique.

## 9. Integrity verification (`src/web/assetLibrary/integrity.ts`)

~~~ts
export type VerifiedPayload = {digest: string} & PayloadMetadata;

export type PayloadVerification =
  | {ok: true; payload: VerifiedPayload; blob: Blob}
  | {ok: false; reason: "missing" | "corrupt"; detail: string};

export const verifyPayload = async (
  store: AssetLibraryStore,
  digest: string,
  deps?: {subtle?: SubtleCrypto},
): Promise<PayloadVerification>;

export class IntegrityCache {
  /** Keeps the verified Blob handle too, so a cache hit can still produce a runtime source. */
  get(digest: string): {payload: VerifiedPayload; blob: Blob} | undefined;
  set(payload: VerifiedPayload, blob: Blob): void;
  invalidate(digests: Iterable<string>): void;
  clear(): void;
}

/** Verifies digests strictly one after another (MAX one payload in memory). */
export const verifyPayloadsSequentially = async (
  store: AssetLibraryStore,
  digests: readonly string[],
  cache: IntegrityCache,
  deps?: {subtle?: SubtleCrypto},
): Promise<Map<string, PayloadVerification>>;
~~~

`verifyPayload` steps:

1. `payloadMeta[digest]` must be `present` (absent → `missing`, corrupt → `corrupt`).
2. `blobs[digest]` must be `present` (absent → `missing`).
3. `blob.size === payloadMeta.byteSize`, else `corrupt`.
4. `bytes = new Uint8Array(await blob.arrayBuffer())`; `sha256Hex(bytes) === digest`, else `corrupt`.
5. `inspectImageBytes(bytes)` must succeed and its `mimeType`, `width`, `height` must equal `payloadMeta`, else `corrupt`.
6. Drop the `bytes` reference before returning `{ok: true, payload, blob}`.

`verifyPayloadsSequentially` uses a plain `for … of` with `await` (never `Promise.all`). A cache hit skips steps 2–5 and returns the cached `{payload, blob}`, but still requires `payloadMeta` to be present and equal to the cached payload (so a deleted digest is not served from cache). Holding the `Blob` handle is cheap: it references the stored bytes, it does not copy them. The cache lives in memory only, for the page session; the app invalidates it on local mutations and on `asset-library-changed` messages.

Because verification requires `payloadMeta` to equal the real bytes, metadata-based budget totals (ASSET-001) equal real totals for every verified digest (D-10).

## Tasks

- [ ] **1. Fixtures and test helpers.** Create `tests/helpers/imageBytes.mjs` (crafted headers: valid minimal PNG/JPEG/WebP-VP8/VP8L/VP8X headers with chosen dimensions, APNG with `acTL`, VP8X with animation flag, VP8X static with an `ANIM` chunk, GIF/SVG/AVIF signatures, truncated variants, 8193-wide and 7072×7072 headers) and real decodable fixtures in `tests/fixtures/local-assets/`:
  - `pose-magenta.png` — 600×900 RGBA PNG, transparent background with an opaque magenta rectangle (generate in Node with `zlib.deflateSync` + `zlib.crc32`, via a committed script `tests/fixtures/local-assets/generate.mjs`);
  - `background-cyan.jpg` — 1080×1920 JPEG, top half cyan / bottom half yellow (generate in the same script by launching Playwright Chrome and using `OffscreenCanvas.convertToBlob({type: "image/jpeg"})`);
  - `background-noext` — a static WebP (same pattern as the JPEG, generated the same way) saved **without** extension;
  - `README.md` stating these are test-only and how to regenerate them.
  Commit the generated files; tests read them from disk.
- [ ] **2. Image inspection + hashing.** `imageInspection.ts`, `hash.ts`, `tests/image-inspection.test.mjs`.
- [ ] **3. Records, store interface, in-memory fake, library operations.** `records.ts`, `store.ts`, `library.ts`, `tests/helpers/memoryAssetStore.mjs`, `tests/asset-library.test.mjs`. The fake implements the exact semantics of §4 and counts reads per store (`reads.assets`, `reads.payloadMeta`, `reads.blobs`, `reads.thumbnails`), can inject raw values (to simulate corrupt rows) and can fail `apply` with a quota error.
- [ ] **4. Import pipeline.** `importAsset.ts`, `thumbnails.ts`, more cases in `tests/asset-library.test.mjs` (inject `decode`/`makeThumbnail` fakes in Node).
- [ ] **5. Integrity verification.** `integrity.ts`, `tests/asset-integrity.test.mjs`.
- [ ] **6. IndexedDB adapter + coordination + harness.** `indexedDbStore.ts`, `coordination.ts`, harness page, `playwright.harness.config.mjs`, `tests/harness/asset-library-indexeddb.spec.mjs`, `package.json` script, CI step.

## Tests

`tests/image-inspection.test.mjs`

- accepts PNG, JPEG, WebP VP8/VP8L/VP8X(static) with correct `mimeType`/dimensions, including the real fixtures;
- extensionless fixture is accepted (inspection never looks at names);
- rejects: empty → `empty`; `MAX_LOCAL_ASSET_BYTES + 1` bytes → `too-large` (size check runs before parsing — use a `Uint8Array` of that length); GIF/SVG/AVIF/text → `unsupported-format`; APNG and both animated WebP forms → `animated`; 8193 px side → `dimensions-too-large`; 7072×7072 (50 013 184 px) → `too-many-pixels`; exactly 8192×6103 (49 995 776 px) → accepted; truncated headers and zero dimensions → `malformed`; no exceptions for any random 0–64-byte input (loop a few hundred deterministic pseudo-random inputs);
- `sha256Hex` of a known vector (`"abc"` → `ba7816bf…`) and of each fixture file equals `node:crypto` `createHash("sha256")`.

`tests/asset-library.test.mjs` (in-memory fake)

- import creates `assets[ref]`, `payloadMeta`, `blobs`, `thumbnails`; result `created: true`;
- same bytes + same category again → `created: false`, label/createdAt preserved, `originalFilename` refreshed, backing records rewritten (start from a fake with the blob deleted, then verify it is restored);
- a rename applied to the fake between `prepareLocalAssetImport` and `commitPreparedLocalAssetImport` survives the duplicate re-import (label not reverted);
- same bytes in the other category → second row, single payload/blob/thumbnail;
- importing over a corrupt row (value `{label: 1}` or `{digest: "<other>"}`) rewrites it canonically;
- rename changes only the label; rename of a deleted ref → `not-found` and does not recreate it; empty/whitespace/81-code-point labels rejected by `normalizeLocalAssetLabel`;
- delete one category keeps payload while the other category row exists; delete the last one removes payload/blob/thumbnail; GC uses the digest from the key even when the row value claims another digest;
- quota failure in `apply` leaves the store unchanged and surfaces `storage-full`;
- `prepareLocalAssetImport` rejects oversized files without calling `file.arrayBuffer()` (spy), accepts a decoded size equal to the header size or swapped (EXIF rotation), rejects any other decoded size as `decode-failed`, and calls `onPhase` in order;
- default label rules (D-12): `IMG_0421.webp` → `IMG_0421`, `.png` → `Untitled pose`, long names truncated to 80 code points;
- paging: with 120 pose rows, 3 background rows and 2 non-canonical keys inside the pose prefix (uppercase digest, 10-char digest), page 1 of poses has 50 canonical rows, `hasNext`, no background rows, and the non-canonical keys never appear and are not counted; next/previous navigation returns the right windows; `listAssets` never reads more than `limit + 1` rows (fake counter); `countAssets` returns 120 without listing.

`tests/asset-integrity.test.mjs`

- valid payload verifies and returns metadata equal to `payloadMeta`;
- missing payloadMeta / missing blob → `missing`;
- blob under digest A containing valid image-B bytes → `corrupt` (hash mismatch);
- correct bytes but `payloadMeta` width/height/mimeType/byteSize falsified → `corrupt`;
- an asset row claiming `digest: B` under key `local:pose:sha256:A`: ASSET-004 never asks for B — assert here that `decodeAssetRow` returns `corrupt` and that the fake recorded zero reads for B;
- sequential: a fake whose `blob.arrayBuffer()` tracks concurrency proves at most 1 in flight for 11 digests (simulating ~256 MiB with 23 MiB fake payload sizes — sizes may be faked via `size`/`arrayBuffer` stubs, no real 256 MiB allocation);
- cache hit avoids a second blob read; `invalidate([digest])` forces a re-read; a cached digest whose `payloadMeta` was deleted is not served.

`tests/harness/asset-library-indexeddb.spec.mjs` (harness, real Chrome IndexedDB)

- open creates the 4 stores; import/rename/delete round-trip through real IndexedDB;
- a connection opened in page A closes itself when page B opens the same database with version 2 (harness opens v2 directly), and page A's next call reports the reload message;
- page B's v2 open while page A holds a connection that ignores `versionchange` (harness hook) returns `unavailable` with the close-other-tabs message after the timeout;
- a stored thumbnail of 300×300 or larger than 512 KiB decodes as `corrupt` and the card shows the neutral box;
- reload the page → data still there;
- a transaction that throws mid-way (harness hook) leaves no partial record;
- paging over 120 rows reads one page at a time (verify through the store API, not internals);
- with `navigator.locks` removed before load (`page.addInitScript`), `openAssetLibrary` returns `disabled` and `indexedDB.databases()` does not list `tora-video-engine-assets`;
- two pages in one context: an exclusive mutation in page B waits while page A holds the shared lock, and page A receives an `asset-library-changed` message after B commits.

## Verify

~~~bash
npm test
npm run lint
npm run web:build
npm run test:browser
npm run test:harness
~~~

## Out of scope

UI (ASSET-003), Player/render integration (ASSET-004), CLI (ASSET-005), cloud backup, total-library quotas, recompression.

## Done when

All tasks are ticked; the library can import, deduplicate/repair, rename, page, delete with GC, and verify payloads; and every rule above has a passing test.
