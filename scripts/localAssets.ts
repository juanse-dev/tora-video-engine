import {lstat, mkdir, open, readdir, stat, writeFile} from "node:fs/promises";
import type {Stats} from "node:fs";
import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {sha256Hex} from "../src/localAssets/hash.ts";
import {
  checkLocalAssetByteSize,
  describeImageRejection,
  inspectImageBytes,
} from "../src/localAssets/imageInspection.ts";
import type {
  ImageRejection,
  InspectedImage,
} from "../src/localAssets/imageInspection.ts";
import {collectStoryLocalAssetUsages} from "../src/localAssets/readiness.ts";
import {buildLocalAssetRef} from "../src/localAssets/refs.ts";
import {STAGED_LOCAL_ASSETS_DIR} from "../src/localAssets/sources.ts";
import type {LocalAssetSourceMap} from "../src/localAssets/sources.ts";
import type {Story} from "../src/story/schema.ts";
import type {
  LocalAssetCategory,
  LocalAssetRef,
} from "../src/localAssets/refs.ts";

export const LOCAL_ASSETS_ROOT = "local-assets";

export const categoryFolder = {
  pose: "poses",
  background: "backgrounds",
} as const;

export type CandidateResult =
  | {
      relativePath: string;
      ok: true;
      ref: LocalAssetRef;
      digest: string;
      image: InspectedImage;
      bytes: Uint8Array;
    }
  | {
      relativePath: string;
      ok: false;
      reason: ImageRejection | "changed-during-scan" | "unreadable";
    };

export type ScanDeps = {
  stat?: typeof import("node:fs/promises").stat; // root and category folders (follows symlinks)
  lstat?: typeof import("node:fs/promises").lstat; // entries inside a category (symlinks are skipped)
  readdir?: typeof import("node:fs/promises").readdir;
  open?: typeof import("node:fs/promises").open;
  onCandidateStart?: (relativePath: string) => void; // test instrumentation
  onCandidateEnd?: (relativePath: string) => void;
};

/** The root for this process: the test/CI override, else `local-assets`. */
export const getLocalAssetsRoot = (): string =>
  process.env.TORA_LOCAL_ASSETS_ROOT ?? LOCAL_ASSETS_ROOT;

/**
 * The root as shown to people: relative to the current working directory
 * (`local-assets` for the default root) with `/` separators. A root outside
 * the working directory is shown as an absolute path instead of `../..` chains.
 * Shared by `npm run assets` and the missing-asset error so they cannot diverge.
 */
export const displayRoot = (
  root: string,
  cwd: string = process.cwd(),
): string => {
  const absolute = resolve(cwd, root);
  const fromCwd = relative(cwd, absolute);
  const inside =
    !isAbsolute(fromCwd) && fromCwd !== ".." && !fromCwd.startsWith(`..${sep}`);
  const shown = inside ? fromCwd : absolute;

  return shown === "" ? "." : shown.split("\\").join("/");
};

const isErrnoCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as {code?: unknown}).code === code;

/** Plain UTF-16 code unit comparison; deliberately not locale-aware. */
const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

type Entry = {relativePath: string; stats: Stats};

const categoryDirectory = (
  root: string,
  category: LocalAssetCategory,
): string => join(root, categoryFolder[category]);

/**
 * True when `<root>/<categoryFolder>` is a directory, or a symlink to one
 * (the folder itself may be linked, e.g. into a cloud drive). A missing or
 * dangling folder, or a file, yields false. Other errors propagate.
 */
export const categoryFolderExists = async (
  root: string,
  category: LocalAssetCategory,
  deps: ScanDeps = {},
): Promise<boolean> => {
  const statImpl = deps.stat ?? stat;

  try {
    const stats = await statImpl(categoryDirectory(root, category));

    return stats.isDirectory();
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return false;
    }

    throw error;
  }
};

/**
 * Paths only: every regular file under the category folder, recursively.
 * Symbolic links (to files or directories) are skipped and never traversed.
 */
const enumerateRegularFiles = async (
  directory: string,
  deps: ScanDeps,
): Promise<Entry[]> => {
  const lstatImpl = deps.lstat ?? lstat;
  const readdirImpl = deps.readdir ?? readdir;
  const entries: Entry[] = [];

  const walk = async (absolute: string, prefix: string): Promise<void> => {
    const names = await readdirImpl(absolute);

    for (const name of names) {
      const childAbsolute = join(absolute, name);
      const childRelative = prefix === "" ? name : `${prefix}/${name}`;
      const stats = await lstatImpl(childAbsolute);

      if (stats.isSymbolicLink()) {
        continue;
      }

      if (stats.isDirectory()) {
        await walk(childAbsolute, childRelative);
      } else if (stats.isFile()) {
        entries.push({relativePath: childRelative, stats});
      }
    }
  };

  await walk(directory, "");

  // Sorting the complete relative paths (not per directory) is what makes
  // "a.png" < "a/z.png": "." sorts before "/".
  entries.sort((left, right) =>
    compareStrings(left.relativePath, right.relativePath),
  );

  return entries;
};

const sameIdentity = (
  before: Pick<Stats, "size" | "dev" | "ino">,
  after: Pick<Stats, "size" | "dev" | "ino">,
): boolean =>
  after.size === before.size &&
  (before.ino === 0 || (after.dev === before.dev && after.ino === before.ino));

const inspectEntry = async (
  directory: string,
  entry: Entry,
  category: LocalAssetCategory,
  deps: ScanDeps,
): Promise<CandidateResult> => {
  const {relativePath, stats} = entry;
  const size = checkLocalAssetByteSize(stats.size);

  if (!size.ok) {
    return {relativePath, ok: false, reason: size.reason};
  }

  const openImpl = deps.open ?? open;
  const absolute = join(directory, ...relativePath.split("/"));
  let bytes: Uint8Array;

  try {
    const handle = await openImpl(absolute, "r");

    try {
      const opened = await handle.stat();

      if (!opened.isFile() || !sameIdentity(stats, opened)) {
        return {relativePath, ok: false, reason: "changed-during-scan"};
      }

      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return {relativePath, ok: false, reason: "unreadable"};
  }

  const inspection = inspectImageBytes(bytes);

  if (!inspection.ok) {
    return {relativePath, ok: false, reason: inspection.reason};
  }

  const digest = await sha256Hex(bytes);

  return {
    relativePath,
    ok: true,
    ref: buildLocalAssetRef(category, digest),
    digest,
    image: inspection.image,
    bytes,
  };
};

/**
 * Yields candidate results one by one in deterministic order.
 * The consumer must finish with a result (and drop `bytes`) before the generator reads the next file.
 *
 * `relativePath` is relative to the category folder and `/`-separated.
 */
export async function* scanCategory(
  root: string,
  category: LocalAssetCategory,
  deps: ScanDeps = {},
): AsyncGenerator<CandidateResult> {
  if (!(await categoryFolderExists(root, category, deps))) {
    return;
  }

  const directory = categoryDirectory(root, category);
  const entries = await enumerateRegularFiles(directory, deps);

  for (const entry of entries) {
    deps.onCandidateStart?.(entry.relativePath);

    try {
      yield await inspectEntry(directory, entry, category, deps);
    } finally {
      deps.onCandidateEnd?.(entry.relativePath);
    }
  }
}

export type InventoryLine =
  | {relativePath: string; ref: LocalAssetRef}
  | {relativePath: string; rejected: string}; // describeImageRejection or scan reason

const describeScanFailure = (
  reason: ImageRejection | "changed-during-scan" | "unreadable",
): string => {
  switch (reason) {
    case "changed-during-scan":
      return "The file changed while it was being scanned.";
    case "unreadable":
      return "The file could not be read.";
    default:
      return describeImageRejection(reason);
  }
};

const inventoryCategory = async (
  root: string,
  category: LocalAssetCategory,
  deps: ScanDeps,
): Promise<InventoryLine[]> => {
  const lines: InventoryLine[] = [];

  for await (const result of scanCategory(root, category, deps)) {
    lines.push(
      result.ok
        ? {relativePath: result.relativePath, ref: result.ref}
        : {
            relativePath: result.relativePath,
            rejected: describeScanFailure(result.reason),
          },
    );
  }

  return lines;
};

/**
 * Inventories every candidate in both categories (no early stop).
 * Line paths are relative to the category folder.
 */
export const inventoryLocalAssets = async (
  root: string,
  deps: ScanDeps = {},
): Promise<{
  rootExists: boolean;
  poses: InventoryLine[];
  backgrounds: InventoryLine[];
}> => {
  const statImpl = deps.stat ?? stat;

  try {
    const stats = await statImpl(root);

    if (!stats.isDirectory()) {
      return {rootExists: false, poses: [], backgrounds: []};
    }
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return {rootExists: false, poses: [], backgrounds: []};
    }

    throw error;
  }

  const poses = await inventoryCategory(root, "pose", deps);
  const backgrounds = await inventoryCategory(root, "background", deps);

  return {rootExists: true, poses, backgrounds};
};

export type StagedLocalAssets = {sources: LocalAssetSourceMap};

export class MissingLocalAssetsError extends Error {
  override name = "MissingLocalAssetsError";
}

const stagedExtension = (mimeType: InspectedImage["mimeType"]): string => {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
  }
};

const categoryHeading = {pose: "Pose", background: "Background"} as const;

const formatMissingLocalAssets = (
  root: string,
  missing: ReturnType<typeof collectStoryLocalAssetUsages>,
): string => {
  const count = missing.length;
  const lines = [
    count === 1
      ? "Cannot render Story: 1 local asset is missing."
      : `Cannot render Story: ${count} local assets are missing.`,
  ];

  for (const category of ["pose", "background"] as const) {
    const inCategory = missing.filter((usage) => usage.category === category);

    if (inCategory.length === 0) {
      continue;
    }

    lines.push("", `${categoryHeading[category]}:`);

    for (const [index, usage] of inCategory.entries()) {
      if (index > 0) {
        lines.push("");
      }

      lines.push(
        `  ${usage.ref}`,
        `  used by scenes: ${usage.sceneIndexes.map((scene) => scene + 1).join(", ")}`,
        `  searched: ${displayRoot(root)}/${categoryFolder[category]}/`,
      );
    }
  }

  lines.push(
    "",
    "Copy the original PNG/JPEG/WebP file into that folder (any filename),",
    "or replace the reference in the Story. Run `npm run assets` to list the refs",
    "of the files that are there.",
  );

  return lines.join("\n");
};

/**
 * Requires every local ref in the Story. Writes matches into
 * `${publicDir}/${STAGED_LOCAL_ASSETS_DIR}/<category>/<digest>.<ext>`.
 * Skips categories with no required refs; stops a category as soon as all its digests are staged.
 * Throws MissingLocalAssetsError before anything is spawned.
 *
 * Each match is written from the in-memory bytes before the next file is
 * read, so later edits to the source cannot change what renders.
 */
export const stageLocalAssetsForStory = async (
  story: Story,
  options: {
    root: string;
    publicDir: string;
    onStaged?: (ref: LocalAssetRef, stagedPath: string) => Promise<void> | void;
  },
  deps: ScanDeps = {},
): Promise<StagedLocalAssets> => {
  const usages = collectStoryLocalAssetUsages(story);
  const sources: Partial<Record<LocalAssetRef, LocalAssetSourceMap[LocalAssetRef]>> =
    {};
  const missing: typeof usages = [];

  for (const category of ["pose", "background"] as const) {
    const required = new Map(
      usages
        .filter((usage) => usage.category === category)
        .map((usage) => [usage.digest, usage]),
    );

    if (required.size === 0) {
      continue;
    }

    const stagedDigests = new Set<string>();

    for await (const candidate of scanCategory(options.root, category, deps)) {
      if (!candidate.ok || !required.has(candidate.digest)) {
        continue;
      }

      if (stagedDigests.has(candidate.digest)) {
        continue;
      }

      const sourcePath = `${STAGED_LOCAL_ASSETS_DIR}/${category}/${candidate.digest}.${stagedExtension(candidate.image.mimeType)}`;
      const stagedPath = join(options.publicDir, ...sourcePath.split("/"));

      await mkdir(dirname(stagedPath), {recursive: true});
      await writeFile(stagedPath, candidate.bytes);

      stagedDigests.add(candidate.digest);
      sources[candidate.ref] = {kind: "static", path: sourcePath};
      await options.onStaged?.(candidate.ref, stagedPath);

      if (stagedDigests.size === required.size) {
        break;
      }
    }

    for (const [digest, usage] of required) {
      if (!stagedDigests.has(digest)) {
        missing.push(usage);
      }
    }
  }

  if (missing.length > 0) {
    throw new MissingLocalAssetsError(
      formatMissingLocalAssets(options.root, missing),
    );
  }

  return {sources};
};
