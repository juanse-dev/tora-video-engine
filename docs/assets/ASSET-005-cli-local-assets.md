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

The CLI builds an index from local files:

~~~text
category + SHA-256(original bytes)
              ↓
         filesystem path
~~~

This is what makes an exported browser Story portable without embedding bytes.

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
5. traverse relevant local asset category directories deterministically and inspect candidates with the bounded scanner defined below;
6. resolve required same-category refs and stop scanning a category as soon as every ref required from that category has been found;
7. fail before launching Remotion if any required ref is missing;
8. prepare an ephemeral runtime source map/staging area;
9. invoke the shared Remotion composition with Story + resolved source map;
10. remove temporary staging data after render/failure.

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
- when a candidate resolves a required digest, record its deterministic path;
- once every required digest in that category has been found, stop traversing/inspecting remaining candidates in that category;
- if traversal ends with unresolved refs, report the normal missing-asset error before Remotion spawn.

Because duplicate files with the same digest are byte-identical, deterministic traversal + first match is sufficient and preserves stable staging/debug selection.

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

### Symlink policy

v0.3 **does not follow filesystem symlinks** while scanning `local-assets/`.

Scanner requirements:

- use `lstat()`/equivalent when classifying directory entries;
- if an entry is a symbolic link, skip it regardless of whether it targets a file or directory;
- do not recurse through symlinked directories;
- do not read/hash symlinked files;
- regular files/directories reached without following a symlink remain eligible under the normal content-first rules.

This intentionally favors a simple, auditable containment guarantee over supporting symlinked personal asset trees in v0.3.

The fixed roots plus the no-symlink rule guarantee the scanner never reads outside the actual `local-assets/poses/` or `local-assets/backgrounds/` directory tree through link traversal.

Exported YAML still never contains machine-specific absolute paths.

## Runtime staging

The shared Remotion composition consumes an ephemeral runtime source map as defined by ASSET-004.

For CLI/local rendering, the render setup must expose the matched files to the headless Remotion page using an ephemeral local/static staging mechanism.

Requirements:

- do not copy custom files into tracked `public/`;
- do not mutate the Story;
- do not encode image bytes/base64 into YAML;
- do not leave staging files after success/failure;
- pass only runtime source URLs/paths that are valid for the render lifetime;
- preserve original file bytes.

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
- deterministic lexical traversal chooses the same first path when duplicate byte-identical files exist;
- symlink-to-file inside a category root is skipped and never read/hashed;
- symlink-to-directory inside a category root is not traversed, including when its target is outside the root;
- a regular nested file beside skipped symlinks still resolves normally.

## Acceptance criteria

- local custom assets require only copying supported files into the documented local folders plus using the built-in helper when a local-only author needs the canonical ref;
- YAML remains machine-independent and contains no paths/bytes;
- the same file resolves to the same ref in browser and Node regardless of filename extension;
- missing assets fail early with actionable diagnostics;
- bundled-only CLI behavior remains unchanged;
- custom asset staging is ephemeral and deterministic;
- CLI scanning never follows symlinks and therefore cannot escape the fixed category roots through link traversal;
- CLI payload inspection is bounded to one candidate at a time, while render resolution may early-stop once all required refs are found;
- the required helper exposes full copy/pasteable refs without introducing a manifest.

## Out of scope

- watching folders for live changes;
- cloud download;
- browser-to-filesystem automatic sync;
- user-maintained manifests;
- source-controling personal assets by default;
- arbitrary external asset directories.

## Done when

A YAML exported from the browser can render locally after the user copies the exact referenced image files into the correct `local-assets/poses` and/or `local-assets/backgrounds` category. A local-only author can obtain the exact YAML refs from the required helper command without creating a manifest.
