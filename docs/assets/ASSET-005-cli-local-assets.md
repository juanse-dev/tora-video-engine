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

Only supported image files are candidates for the local index.

A supported extension does not override invalid content: inspect the file structure/content, reject animated PNG/WebP, enforce dimensions/pixel limits, and require successful decode before accepting/indexing a file.

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
5. scan/validate/hash only relevant local asset category directories using the same source limits as browser import;
6. resolve every required same-category ref;
7. fail before launching Remotion if any required ref is missing;
8. prepare an ephemeral runtime source map/staging area;
9. invoke the shared Remotion composition with Story + resolved source map;
10. remove temporary staging data after render/failure.

Do not make Remotion discover arbitrary local files itself.

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

This prevents path traversal and means exported YAML never contains machine-specific absolute paths.

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
- use the same validation/hash/index code as the render path;
- reject/report unsupported, animated, oversized, over-dimension, or undecodable files consistently;
- do not create a user-maintained manifest or make filenames part of identity.

The exact script name/output formatting may be refined during implementation, but this capability is required for v0.3.

## Tests

Minimum automated coverage:

- bundled-only Story does not require `local-assets/`;
- pose/background directory indexing is category-aware;
- SHA-256 matches browser test vectors;
- nested supported files resolve if recursive scan is implemented;
- unsupported/invalid-content files do not satisfy refs;
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
- helper and render indexing apply the same format/resource validation.

## Acceptance criteria

- local custom assets require only copying supported files into the documented local folders plus using the built-in helper when a local-only author needs the canonical ref;
- YAML remains machine-independent and contains no paths/bytes;
- the same file resolves to the same ref in browser and Node;
- missing assets fail early with actionable diagnostics;
- bundled-only CLI behavior remains unchanged;
- custom asset staging is ephemeral and deterministic;
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
