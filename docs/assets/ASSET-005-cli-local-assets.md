# ASSET-005 — CLI local assets and missing-asset recovery

> Status: **Proposed**

## Goal

Make a browser-exported Story that references custom images renderable from a local checkout by copying the same image files into simple gitignored folders.

The CLI must resolve the **same content-addressed refs** defined by ASSET-001. No browser database export, manifest editing, YAML byte embedding, or source-code changes are required.

## User workflow

Default local asset root:

~~~text
local-assets/
  poses/
  backgrounds/
~~~

Example:

~~~text
local-assets/
  poses/
    shiar-formal.png
    shiar-confused.webp
  backgrounds/
    apartment.jpg
    bogota-night.webp
~~~

These directories are user-owned runtime data and must be gitignored by default.

They are intentionally separate from Tora's source-controlled bundled `public/` assets.

## Supported files

CLI local assets follow the same v0.3 source rules as browser imports:

- static PNG (APNG rejected);
- JPEG (`.jpg` / `.jpeg`);
- static WebP (animated WebP rejected);
- source size >0 and ≤25 MiB;
- width ≤8192 px;
- height ≤8192 px;
- total decoded pixels ≤50 MP.

Every regular file under the relevant local asset directory is a **content candidate**, regardless of filename extension.

The CLI must be content-first exactly like the browser:

- extension and inferred MIME are hints only;
- a valid PNG/JPEG/WebP with no extension or with an incorrect extension is still accepted if its bytes pass validation;
- an invalid payload with a supported-looking extension is rejected;
- animated PNG/WebP, over-limit dimensions/pixels, and undecodable content are rejected from the bytes/content, not from naming.

The CLI may use file size from `stat` to reject zero-byte or >25 MiB files before reading their contents.

## No manifest required

The default v0.3 workflow must not require a user-maintained manifest.

The CLI discovers content identity from local files:

~~~text
category + SHA-256(original bytes)
~~~

For the inventory/helper flow, that identity may be associated with the deterministic source path for display.

For the render flow, a required match is **not** represented only by the mutable source path. The verified bytes are immediately copied into the render's private ephemeral staging area, and the runtime source map points at that staged snapshot.

This is what makes an exported browser Story portable without embedding bytes while preserving the content-addressed identity through render.

## Category directories are authoritative

Files under:

~~~text
local-assets/poses/
~~~

can satisfy only:

~~~text
local:pose:sha256:<digest>
~~~

Files under:

~~~text
local-assets/backgrounds/
~~~

can satisfy only:

~~~text
local:background:sha256:<digest>
~~~

Placing the same file in both categories is allowed. The bytes/ref digest is the same but the category-scoped Story refs differ.

The implementation may scan category directories recursively so users can organize files into subfolders; nested path names are not part of identity.

## CLI resolution order

For `npm run video -- story.yaml`:

1. parse/validate Story;
2. apply existing deterministic output/stale-file safeguards;
3. collect distinct local visual refs;
4. if no local refs exist, preserve the v0.2 path with no local-folder requirement;
5. create a private ephemeral staging directory for this render attempt;
6. traverse relevant local asset category directories deterministically and inspect candidates with the bounded scanner defined below;
7. when the currently materialized/validated bytes match a required same-category digest, write **those exact bytes immediately** to the private staging area before releasing that candidate buffer; record the staged snapshot, not the source path, as the resolved runtime source;
8. stop scanning a category as soon as every ref required from that category has a staged snapshot;
9. fail before launching Remotion if any required ref is missing or could not be snapshotted;
10. invoke the shared Remotion composition with Story + the staged runtime source map;
11. remove temporary staging data after render/failure.

Do not make Remotion discover arbitrary local files itself.

## Bounded CLI scanner

CLI indexing must remain bounded even when `local-assets/` contains many large files.

For v0.3:

~~~ts
MAX_CONCURRENT_CLI_ASSET_INSPECTIONS = 1
~~~

Traversal and inspection rules:

- directory traversal is deterministic; sort eligible directory entries lexicographically by normalized relative path before processing;
- classify entries with `lstat()` and skip symlinks per the security policy;
- use file stat/size to reject zero-byte or >25 MiB candidates before materializing file contents;
- open/read/validate/hash/decode **one regular-file candidate at a time**;
- release its file handle, byte buffer, decoder state, and other per-file temporary resources before materializing the next candidate;
- never use unbounded `Promise.all()`/parallel reads over discovered files;
- lightweight path enumeration may exist in memory, but payload bytes/file handles/decoders remain bounded by the inspection concurrency.

### Render resolver early-stop

For `npm run video -- story.yaml`:

- build the required digest set per category first;
- do not scan a category with zero required local refs;
- when a candidate resolves a required digest, synchronously/awaitedly persist the exact already-verified candidate bytes into the render's private staging area **before** releasing the candidate payload;
- use a deterministic staged filename derived from category + digest + detected format, not from the mutable source filename;
- record the staged snapshot path/URL as the resolved runtime source; do not later reopen the original source path for staging;
- once every required digest in that category has a successfully written staged snapshot, stop traversing/inspecting remaining candidates in that category;
- if traversal ends with unresolved refs, report the normal missing-asset error before Remotion spawn.

Because duplicate files with the same digest are byte-identical, deterministic traversal + first successfully snapshotted match is sufficient. Source-path selection remains deterministic for diagnostics, while render content comes only from the staged bytes that produced the digest.

### Full helper inventory

`npm run assets` intentionally inventories all eligible files so it can print refs for local authoring.

It therefore cannot early-stop based on a Story, but it must use the same `MAX_CONCURRENT_CLI_ASSET_INSPECTIONS = 1` scanner and release each payload before moving to the next file.

No aggregate CLI byte/pixel budget is introduced; the resource bound is on concurrent materialization, not total library size.

## Hashing

Use Node's SHA-256 over the exact original bytes.

The digest must match browser Web Crypto SHA-256 byte-for-byte.

Do not include:

- filename;
- relative path;
- mtime;
- category;
- label

in the hash.

## Duplicate files

If multiple files in one category have identical bytes/digest:

- they represent the same local asset ref;
- resolution is not ambiguous because content is identical;
- choose one deterministic path (for example lexicographically first) or deduplicate during indexing;
- do not fail the Story merely because duplicate copies exist.

A diagnostic/debug message is acceptable but not required.

## Missing-asset error

Missing local refs are a pre-render error.

The message must identify:

- category;
- digest/ref;
- affected scene numbers/indexes;
- directory that was searched;
- how to repair the problem.

Example:

~~~text
Cannot render Story: 1 local asset is missing.

Pose:
  local:pose:sha256:abcd...7890
  used by scenes: 1, 3
  searched: local-assets/poses/

Copy the matching PNG/JPEG/WebP into the local asset folder
or replace the reference in the Story.
~~~

The CLI must fail **before spawning Remotion**.

Existing stale-output removal guarantees remain intact.

## Security/path safety

Never convert arbitrary YAML text into a filesystem path.

A local Story ref provides only:

~~~text
category + expected SHA-256
~~~

The CLI discovers files from the fixed local asset roots and matches by computed digest.

### Symlink policy and filesystem-stability assumption

v0.3 does not intentionally follow filesystem symlinks while scanning `local-assets/`.

For the normal supported case, the local asset tree is assumed to be **quiescent for the duration of one CLI scan**: no editor, sync tool, script, or other process is expected to replace files/directories with symlinks between filesystem syscalls.

Scanner requirements:

- use `lstat()`/equivalent when classifying directory entries;
- if an entry is observed as a symbolic link, skip it regardless of whether it targets a file or directory;
- do not recurse through entries observed as symlinked directories;
- do not read/hash entries observed as symlinked files;
- for a file candidate, compare identity/metadata available from the pre-open classification with the opened handle's `fstat()`/equivalent **before reading bytes** where the platform exposes stable file identity (for example device/inode); if they disagree, close and reject that candidate;
- if file size/type changes between classification and opened-handle validation, reject/fail that candidate rather than continuing with stale assumptions;
- regular files/directories reached in a stable tree without observed symlink traversal remain eligible under the normal content-first rules.

This protects ordinary local use and catches detectable file replacement races before payload reads, but v0.3 **does not claim adversarial race-hardening against a separate process concurrently mutating directory entries between syscalls on every supported OS/filesystem**.

In particular, recursive directory traversal is not specified as an `openat(..., O_NOFOLLOW)`-style capability-secure walk across all platforms. Users/tools must not mutate the `local-assets/` tree concurrently with a render/index command if they require deterministic containment.

If stronger race-resistant filesystem containment is required later, it should be introduced as a separately specified platform abstraction rather than implied by `lstat()` alone.

Exported YAML still never contains machine-specific absolute paths.

## Runtime staging

The shared Remotion composition consumes an ephemeral runtime source map as defined by ASSET-004.

For CLI/local rendering, the render setup exposes **snapshotted verified bytes** to the headless Remotion page using an ephemeral local/static staging mechanism.

Requirements:

- create a private staging directory before candidate resolution;
- when a required digest is matched, write the exact in-memory bytes that were just validated/hashed directly into staging before releasing that buffer;
- never resolve a required ref by remembering only the original source path and reopening it later;
- source-file changes after a successful snapshot cannot change the staged render bytes;
- if the staged write fails, that ref is unresolved and rendering fails before Remotion spawn;
- do not copy custom files into tracked `public/`;
- do not mutate the Story;
- do not encode image bytes/base64 into YAML;
- do not leave staging files after success/failure;
- pass only staged runtime source URLs/paths that are valid for the render lifetime;
- preserve the verified original bytes byte-for-byte in the staged snapshot.

The exact Remotion staging mechanism may be chosen during implementation, but it must be covered end-to-end by tests rather than assuming `file://` works.

## Local development

The primary v0.3 requirement is the `npm run video -- story.yaml` CLI flow.

If Remotion Studio is also taught to resolve `local-assets/`, it must reuse the same Node resolver/index rather than inventing a second local-file convention.

Studio integration is optional for v0.3 unless required by implementation ergonomics.

## Browser → CLI portability flow

Expected manual workflow:

~~~text
Browser
  1. import my-cat.png
  2. Story gets local:pose:sha256:<digest>
  3. export YAML

Local checkout
  4. copy YAML into project
  5. copy exact my-cat.png into local-assets/poses/
  6. npm run video -- story.yaml
  7. CLI hashes file → same digest → resolves → renders
~~~

No synchronization service participates.

## Replacement semantics

If the user copies a **different** image into the folder, its hash differs and it does not repair the missing reference.

To intentionally use the different image:

- import/select it in browser and export updated YAML; or
- update the YAML reference to the new file's correctly derived ref through a supported local inspection/helper flow.

v0.3 does not match by filename similarity.

## Required local ref discovery helper

v0.3 must include a local command/helper for authoring Stories directly from a checkout after copying files into `local-assets/`.

Expected UX:

~~~bash
npm run assets
~~~

Example output shape:

~~~text
local-assets/poses/my-cat.png
  local:pose:sha256:<full-64-lowercase-hex-digest>

local-assets/backgrounds/apartment.jpg
  local:background:sha256:<full-64-lowercase-hex-digest>
~~~

Requirements:

- print the **complete canonical ref**, not an abbreviated digest, so it is directly copy/pasteable into YAML;
- use the same bounded validation/hash/index scanner as the render path;
- reject/report unsupported, animated, oversized, over-dimension, or undecodable files consistently;
- do not create a user-maintained manifest or make filenames part of identity.

The exact script name/output formatting may be refined during implementation, but this capability is required for v0.3.

## Tests

Minimum automated coverage:

- bundled-only Story does not require `local-assets/`;
- pose/background directory indexing is category-aware;
- SHA-256 matches browser test vectors;
- nested regular files resolve if recursive scan is implemented;
- valid PNG/JPEG/WebP bytes resolve even when the filename has no extension or an incorrect extension;
- browser and CLI accept the same extensionless/misnamed valid-content fixture and compute the same ref;
- unsupported/invalid-content files do not satisfy refs even when named `.png`, `.jpg`, or `.webp`;
- APNG/animated WebP do not satisfy refs;
- >25 MiB candidate is not hashed/accepted;
- >8192 px/side or >50 MP candidates are not accepted;
- same bytes under duplicate filenames resolve deterministically;
- same bytes in background directory cannot satisfy a pose ref;
- all required refs resolved → runtime source map contains each ref once;
- missing ref lists affected scenes and searched category path;
- missing ref fails before Remotion spawn;
- stale output is not left after missing-asset failure;
- staging does not mutate tracked `public/`;
- staging is cleaned after success/failure;
- end-to-end CLI fixture renders one custom pose and one custom background;
- browser/Node hash of the same fixture bytes produces identical refs;
- required asset helper prints complete canonical refs for valid files;
- helper and render indexing apply the same format/resource validation;
- instrumentation over a large near-limit fixture proves at most one candidate payload/file handle/decoder is materialized for inspection at a time;
- render resolver skips categories with no required refs and stops a category immediately after all of its required digests are found;
- helper still inventories all eligible candidates but retains concurrency 1;
- deterministic lexical traversal chooses the same first successfully snapshotted source when duplicate byte-identical files exist;
- required digest A is discovered from source bytes A, source file is then replaced/modified to bytes B before Remotion spawn, and render still consumes staged snapshot A (or the snapshot write fails closed) — never B under ref A;
- staged snapshot bytes hash back to the required digest before the runtime source map is finalized in the test harness;
- a stat/open identity mismatch detected before payload read rejects the candidate;
- symlink-to-file present at classification time is skipped and not payload-read/hashed;
- symlink-to-directory present at classification time is not traversed;
- a regular nested file beside skipped symlinks still resolves normally;
- concurrent adversarial directory-entry replacement between syscalls is documented as outside the v0.3 containment guarantee rather than tested as a promised cross-platform invariant.

## Acceptance criteria

- local custom assets require only copying supported files into the documented local folders plus using the built-in helper when a local-only author needs the canonical ref;
- YAML remains machine-independent and contains no paths/bytes;
- the same file resolves to the same ref in browser and Node regardless of filename extension;
- missing assets fail early with actionable diagnostics;
- bundled-only CLI behavior remains unchanged;
- custom asset staging is ephemeral, deterministic, and created directly from the same verified bytes that produced each required digest;
- render never reopens an original source path after digest resolution to obtain its staged bytes;
- CLI skips symlinks observed during a quiescent scan and rejects detectable stat/open identity changes, while adversarial concurrent filesystem mutation remains explicitly out of scope for v0.3;
- CLI payload inspection is bounded to one candidate at a time, while render resolution may early-stop once all required refs are snapshotted;
- the required helper exposes full copy/pasteable refs without introducing a manifest.

## Out of scope

- watching folders for live changes;
- cloud download;
- browser-to-filesystem automatic sync;
- user-maintained manifests;
- source-controling personal assets by default;
- arbitrary external asset directories.

## Done when

A YAML exported from the browser can render locally after the user copies the exact referenced image files into the correct `local-assets/poses` and/or `local-assets/backgrounds` category. Required render refs are backed by staged snapshots written from the same bytes that produced their digests, so later source-path mutation cannot silently change render content. A local-only author can obtain the exact YAML refs from the required helper command without creating a manifest.
