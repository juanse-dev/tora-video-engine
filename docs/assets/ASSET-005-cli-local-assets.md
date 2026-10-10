# ASSET-005 — CLI local assets

> Status: **Implemented**. `npm run assets` lists refs by content; `npm run video` stages matching originals into a temporary public directory and fails before Remotion starts when a ref is missing; verified by `npm test` and a real render in `npm run test:cli-e2e`.
>
> Depends on: ASSET-001, ASSET-002 tasks 1–2 (fixtures, `imageInspection.ts`, `hash.ts`). Independent of ASSET-003/004. Read [README](./README.md) first (`INV-n`, constants, `D-n`).

## Goal

Make `npm run video -- story.yaml` render a Story that uses local refs, by finding matching image files in a gitignored `local-assets/` folder by content, and add `npm run assets` to print copy-pasteable refs for the files there. No manifest, no browser export, no YAML bytes.

## User workflow

~~~text
local-assets/
  poses/        ← images usable as local:pose:sha256:…
  backgrounds/  ← images usable as local:background:sha256:…
~~~

~~~bash
npm run assets
npm run video -- stories/my-story.yaml
~~~

Browser → CLI: export YAML in the browser, copy the exact original image files into the matching category folder, render.

## Decisions specific to this spec

- **Staging** (D-2): for Stories with local refs, the render uses a temporary public directory = copy of the repository `public/` + `__local-assets/<category>/<digest>.<ext>`, passed with `--public-dir`. The source map entries are `{kind: "static", path: "__local-assets/<category>/<digest>.<ext>"}`. Bundled-only Stories keep today's exact command line (no `--public-dir`).
- **Validation** (D-4): `inspectImageBytes` + `sha256Hex` from `src/localAssets/`. No decoding in Node. If bytes pass header inspection but cannot be decoded, the Remotion render fails and the command exits non-zero (existing behavior for render failures).
- **Root override:** the root is `process.env.TORA_LOCAL_ASSETS_ROOT ?? LOCAL_ASSETS_ROOT` (`"local-assets"`), resolved from the current working directory. Tests and CI use the override; users normally don't.
- **Category folders are authoritative.** Files under `poses/` can only satisfy `local:pose:…`; under `backgrounds/` only `local:background:…`. The same file may be copied into both.
- **Content first.** Every regular file is a candidate regardless of extension; extensions are ignored.
- **One file at a time.** Inspection is strictly sequential; at most one file's bytes are in memory.
- **Deterministic order.** Within a category, first enumerate every regular-file path recursively (paths only, no contents), then sort the complete `/`-separated relative paths with plain string comparison (`a.png` < `a/z.png`, because `.` < `/`), then inspect in that order. Sorting per directory while recursing is **not** equivalent and must not be used. Holding the path list in memory is fine; bytes are still read one file at a time.
- **Symlinks are skipped** (classified with `lstat`). The tree is assumed not to change during one command; detectable changes between `lstat` and the opened handle reject that file. Defending against an adversarial concurrent process is out of scope.
- **Snapshot on match.** When a candidate matches a required digest, its in-memory bytes are written to the staging dir **before** moving to the next file. The original path is never reopened, so later edits to the source cannot change what renders.

## Files

| Action | Path | Purpose |
| --- | --- | --- |
| create | `scripts/localAssets.ts` | Scanner, render resolver/stager, inventory, error formatting. |
| create | `scripts/assets.ts` | `npm run assets` entry point. |
| create | `scripts/renderStory.ts` | `renderStory` moved out of `render.ts` (which runs `main()` on load) so tests can import it; takes injectable `runRemotion`, `tempBase`, `localAssetsRoot`. |
| modify | `scripts/render.ts` | Now only the CLI entry point; staging happens in `renderStory.ts`. |
| modify | `scripts/renderSupport.ts` | `buildRenderArgs(outputPath, propsPath, publicDir?)`. |
| modify | `package.json` | `"assets": "node --experimental-strip-types scripts/assets.ts"`, `"test:cli-e2e": "node --experimental-strip-types --test tests/cli-local-assets.e2e.mjs"`. |
| modify | `.gitignore` | Ignore `local-assets/*` but keep `local-assets/README.md`. |
| create | `local-assets/README.md` | How to use the folders (short). |
| modify | `README.md` (root) | Document `local-assets/`, `npm run assets`, and the browser → CLI flow. |
| modify | `.github/workflows/ci.yml` | Run `npm run test:cli-e2e` after the existing render steps. |
| create | `tests/cli-local-assets.test.mjs`, `tests/cli-local-assets.e2e.mjs`, `stories/ci-local-assets.yaml` | Tests and e2e Story. |

## Interfaces (`scripts/localAssets.ts`)

~~~ts
export const LOCAL_ASSETS_ROOT = "local-assets";
export const categoryFolder = {pose: "poses", background: "backgrounds"} as const;

export type CandidateResult =
  | {relativePath: string; ok: true; ref: LocalAssetRef; digest: string; image: InspectedImage; bytes: Uint8Array}
  | {relativePath: string; ok: false; reason: ImageRejection | "changed-during-scan" | "unreadable"};

export type ScanDeps = {
  lstat?: typeof import("node:fs/promises").lstat;
  readdir?: typeof import("node:fs/promises").readdir;
  open?: typeof import("node:fs/promises").open;
  onCandidateStart?: (relativePath: string) => void; // test instrumentation
  onCandidateEnd?: (relativePath: string) => void;
};

/**
 * Yields candidate results one by one in deterministic order.
 * The consumer must finish with a result (and drop `bytes`) before the generator reads the next file.
 */
export function scanCategory(
  root: string,
  category: LocalAssetCategory,
  deps?: ScanDeps,
): AsyncGenerator<CandidateResult>;

export type StagedLocalAssets = {sources: LocalAssetSourceMap};

export class MissingLocalAssetsError extends Error {} // message formatted as below

/**
 * Requires every local ref in the Story. Writes matches into
 * `${publicDir}/${STAGED_LOCAL_ASSETS_DIR}/<category>/<digest>.<ext>`.
 * Skips categories with no required refs; stops a category as soon as all its digests are staged.
 * Throws MissingLocalAssetsError before anything is spawned.
 */
export const stageLocalAssetsForStory = async (
  story: Story,
  options: {root: string; publicDir: string; onStaged?: (ref: LocalAssetRef, stagedPath: string) => Promise<void> | void},
  deps?: ScanDeps,
): Promise<StagedLocalAssets>;

export type InventoryLine =
  | {relativePath: string; ref: LocalAssetRef}
  | {relativePath: string; rejected: string}; // describeImageRejection or scan reason

/** Inventories every candidate in both categories (no early stop). */
export const inventoryLocalAssets = async (root: string, deps?: ScanDeps): Promise<{
  rootExists: boolean;
  poses: InventoryLine[];
  backgrounds: InventoryLine[];
}>;
~~~

### Per-candidate steps (`scanCategory`)

Enumeration (before any file is opened): if the category folder does not exist (`ENOENT`), or is not a directory, the category has **no candidates** — no error. Otherwise walk it with `readdir` + `lstat`; symbolic link → skip silently (never yielded, never traversed); directory → recurse; regular file → add `{relativePath, lstat}` to the list; anything else → skip. Then sort the list by `relativePath` as above. For each entry, in order:

1. Re-use the enumeration `lstat` result for the checks below.
2. `checkLocalAssetByteSize(lstat.size)` → yield rejection without opening.
3. `handle = await open(path, "r")`; `fstat = await handle.stat()`. If `!fstat.isFile()`, or `fstat.size !== lstat.size`, or (`lstat.ino !== 0` and (`fstat.dev !== lstat.dev` or `fstat.ino !== lstat.ino`)) → close, yield `changed-during-scan`.
4. `bytes = await handle.readFile()`; close the handle (in `finally`).
5. `inspectImageBytes(bytes)` → rejection or image; `digest = await sha256Hex(bytes)`; yield.

Extension for staged files: `png` / `jpg` / `webp` from the inspected `mimeType`.

### Missing-asset error message (exact shape)

~~~text
Cannot render Story: 1 local asset is missing.

Pose:
  local:pose:sha256:<full 64-char digest>
  used by scenes: 1, 3
  searched: local-assets/poses/

Copy the original PNG/JPEG/WebP file into that folder (any filename),
or replace the reference in the Story. Run `npm run assets` to list the refs
of the files that are there.
~~~

Group by category (Pose, then Background), refs in first-appearance order, scenes 1-based. Use the real root path (relative to cwd) in `searched:`. Plural: `N local assets are missing`.

### `npm run assets` output

~~~text
local-assets/poses/my-cat.png
  local:pose:sha256:<64 hex>

local-assets/backgrounds/apartment.jpg
  local:background:sha256:<64 hex>

local-assets/backgrounds/old.gif
  skipped: Only static PNG, JPEG and WebP images are supported.
~~~

If the root does not exist: print `No local-assets/ folder found. Create local-assets/poses/ and local-assets/backgrounds/ and copy images into them.` and exit 0. If the root exists but a category folder is missing (the normal fresh-checkout state: only `local-assets/README.md` is committed), print `local-assets/poses/ (folder not found — create it and copy images into it)` for that category and continue; exit 0. Exit 0 when only some files are rejected; exit 1 only on unexpected errors.

### `scripts/render.ts` changes

After `loadStory` (which already runs after stale-output removal):

1. If `!storyHasLocalAssetRefs(story)` → unchanged v0.2 path.
2. Otherwise: `publicDir = join(temporaryDirectory, "public")`; `cp("public", publicDir, {recursive: true})`; `staged = await stageLocalAssetsForStory(story, {root, publicDir})` (throws before spawn on missing); write props `{story, localAssetSources: staged.sources}`; `buildRenderArgs(outputPath, propsPath, publicDir)` adds `--public-dir=${publicDir}`.
3. The existing `finally` removes the whole temporary directory (props + staged public dir) on success and failure.

## Tasks

- [x] **1. Scanner + inventory + `npm run assets`.** `scanCategory`, `inventoryLocalAssets`, `scripts/assets.ts`, `.gitignore`, `local-assets/README.md`.
- [x] **2. Render staging.** `stageLocalAssetsForStory`, `MissingLocalAssetsError`, changes to `render.ts` / `renderSupport.ts`.
- [x] **3. End-to-end render + docs.** `stories/ci-local-assets.yaml` (two short scenes using the digests of `pose-magenta.png` and `background-cyan.jpg`), `tests/cli-local-assets.e2e.mjs`, CI step, root README.

## Tests

`tests/cli-local-assets.test.mjs` (temp directories via `mkdtemp`; fixtures from `tests/fixtures/local-assets/`)

- root with only `README.md` (no `poses/`, no `backgrounds/`): `inventoryLocalAssets` returns empty lists without throwing and `npm run assets` exits 0; a Story with a local pose ref fails with `MissingLocalAssetsError` (not `ENOENT`);
- bundled-only Story: `stageLocalAssetsForStory` is not called / root not required; `buildRenderArgs` without `publicDir` is identical to today;
- pose fixture in `poses/` and background fixture in `backgrounds/` resolve to the refs computed by `sha256Hex` and to `createHash("sha256")` (browser/Node parity uses the same fixtures as ASSET-002);
- the extensionless WebP fixture and a PNG renamed `photo.jpg` both resolve; a text file named `fake.png`, an APNG, a GIF, and a header claiming 9000×9000 are rejected in inventory and never satisfy a ref;
- a 25 MiB + 1 byte file is rejected without `open` being called (spy via deps);
- order: with `poses/a.png`, `poses/a/z.png` and `poses/b.png`, candidates are opened in exactly that order (full-path sort, not per-directory);
- nested `poses/a/b/pic.png` resolves; the same bytes under `poses/a.png` and `poses/z.png` → staged once, inventory lists both, render is not ambiguous;
- the background fixture placed only in `poses/` does not satisfy a background ref → `MissingLocalAssetsError` whose message matches the exact shape above (scenes, searched folder);
- concurrency: instrumented `onCandidateStart`/`onCandidateEnd` never show more than one candidate in progress across 20 files;
- early stop: with the required pose present as the first of 10 files, only 1 pose candidate is opened; no background candidate is opened when no background ref is required; inventory opens all files;
- snapshot: `onStaged` overwrites the source file with other bytes; the staged file still hashes to the required digest;
- identity change: a `deps.open` that returns a handle whose `stat()` reports a different `ino`/`size` → `changed-during-scan`;
- symlinks (skip the test when `symlink` throws `EPERM`, as on Windows without developer mode): a symlink to a file and a symlink to a directory are not opened/traversed; a regular sibling still resolves;
- staged files live under `publicDir/__local-assets/<category>/<digest>.<ext>` and nothing is written to the repository `public/`;
- render failure and missing-asset failure both leave no temporary directory and no `output/<slug>.mp4`.

`tests/cli-local-assets.e2e.mjs` (real render; run in CI with `npm run test:cli-e2e`)

- set `TORA_LOCAL_ASSETS_ROOT` to a temp root with the two fixtures, run `node --experimental-strip-types scripts/render.ts stories/ci-local-assets.yaml`, expect exit 0 and `output/ci-local-assets.mp4`;
- `npx remotion ffprobe` reports h264, 1080×1920, 30 fps, and the expected duration;
- pixel check: `npx remotion ffmpeg -ss <t> -i <mp4> -vf "crop=8:8:<x>:<y>,scale=1:1" -frames:v 1 -pix_fmt rgb24 <tmp>.png` produces a 1×1 PNG; inflate its `IDAT`, skip the 1 filter byte, read RGB (for a single pixel every PNG filter leaves the bytes unchanged). Assert magenta in the pose area, cyan in the top background area (sample a point not covered by the pose or caption), and include a bundled-only control frame;
- with an empty temp root → exit 1, stderr contains `Cannot render Story`, no MP4.

## Verify

~~~bash
npm test
npm run lint
npm run test:cli-e2e
npm run assets
~~~

## Out of scope

Watching folders, manifests, remote downloads, syncing with the browser, arbitrary asset directories other than the root override, Remotion Studio support, decoding images in Node, defending against concurrent adversarial filesystem changes.

## Done when

All tasks are ticked: a YAML exported from the browser renders from the CLI after copying the exact files into `local-assets/<category>/`; missing files fail before Remotion starts with the documented message; `npm run assets` prints complete refs; bundled-only renders are unchanged.

## Implementation notes

Rulings made while implementing (R1–R9):

- **R1:** the e2e is never run in a way that lets Remotion download a browser: local runs set `TORA_REMOTION_BROWSER_EXECUTABLE` to an installed Chrome and CI uses `/usr/bin/google-chrome`. A normal `npm run video` without that variable may download a browser the first time it renders.
- **R2:** the e2e runs Remotion's `ffprobe`/`ffmpeg` through `process.execPath` plus the Remotion CLI entry, never a bare `npx` (not spawnable without a shell on Windows).
- **R3:** `relativePath` in scan results and inventory lines is relative to the category folder; the printed line adds the root and category folder.
- **R4:** printed paths (inventory lines and the `searched:` line of `MissingLocalAssetsError`) use the shared `displayRoot` helper, so with the default root they read `local-assets/<category>/`.
- **R5:** the root and the category folders are checked with `stat` (a symlinked `poses/` works); entries inside keep `lstat` and symlinks there are skipped.
- **R6:** `displayRoot` shows a root inside the working directory relative to it and a root outside it as an absolute path (no `../..` chains).
- **R7:** `renderStory` lives in `scripts/renderStory.ts` with injectable dependencies; `render.ts` stays the entry point.
- **R8:** an empty or whitespace `TORA_LOCAL_ASSETS_ROOT` counts as unset; the "No ... folder found" message names the root through `displayRoot` (the default root prints the spec text exactly); an existing category folder with no files prints `<root>/<category>/ (no files)`; the e2e spawns have a 5 minute timeout.
- **R9:** cleanup of the temporary directory on a signal (Ctrl+C during Remotion) is deferred to a follow-up; the leak class predates this work and needs its own design (forwarding signals to the Remotion child) and tests.
- Staged files use the category value as folder name: `__local-assets/pose/<digest>.<ext>` and `__local-assets/background/<digest>.<ext>`.
- `stories/ci-local-assets.yaml` embeds the digests of the committed fixtures; the e2e fails with a clear message if the fixtures are regenerated without updating it.
