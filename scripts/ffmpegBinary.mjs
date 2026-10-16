// The ffmpeg and ffprobe binaries that ship in the installed
// @remotion/compositor-* package. No `npx` (not spawnable without a shell on
// Windows) and no system ffmpeg: the CLI audio preflight and the test helpers
// call exactly these binaries, so Windows, macOS and Linux behave alike.
//
// Plain JavaScript on purpose (types: ffmpegBinary.d.mts): Playwright's loader
// cannot import a .ts file from the .mjs test helpers that also use this.

import {chmodSync, statSync} from "node:fs";
import {createRequire} from "node:module";
import {dirname, join} from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

/** True when this Linux uses musl rather than glibc (the compositor ships both). */
const detectMusl = () => {
  const report =
    typeof process.report?.getReport === "function"
      ? process.report.getReport()
      : null;

  return report !== null && typeof report === "object"
    ? !report.header?.glibcVersionRuntime
    : false;
};

/**
 * Name of the npm package that holds ffmpeg/ffprobe for a platform, e.g.
 * `@remotion/compositor-win32-x64-msvc` or `@remotion/compositor-linux-x64-gnu`.
 */
export const compositorPackageName = ({
  platform = process.platform,
  arch = process.arch,
  musl,
} = {}) => {
  switch (platform) {
    case "win32":
      if (arch === "x64") {
        return "@remotion/compositor-win32-x64-msvc";
      }

      break;
    case "darwin":
      if (arch === "x64" || arch === "arm64") {
        return `@remotion/compositor-darwin-${arch}`;
      }

      break;
    case "linux":
      if (arch === "x64" || arch === "arm64") {
        const libc = (musl ?? detectMusl()) ? "musl" : "gnu";

        return `@remotion/compositor-linux-${arch}-${libc}`;
      }

      break;
    default:
      throw new Error(
        `Unsupported platform ${platform} (architecture ${arch}) for the Remotion ffmpeg binaries`,
      );
  }

  throw new Error(
    `Unsupported architecture ${arch} on ${platform} for the Remotion ffmpeg binaries`,
  );
};

const executableName = (name, platform) =>
  platform === "win32" ? `${name}.exe` : name;

const ensureExecutable = (path) => {
  if (process.platform === "win32") {
    return;
  }

  try {
    if ((statSync(path).mode & 0o111) === 0) {
      chmodSync(path, 0o755);
    }
  } catch {
    // Let the spawn report the real problem.
  }
};

let cachedBinaries = null;

/**
 * `{dir, ffmpeg, ffprobe}`: absolute paths from the installed compositor
 * package. `resolvePackage` replaces module resolution (tests).
 */
export const resolveFfmpegBinaries = ({
  platform = process.platform,
  arch = process.arch,
  musl,
  resolvePackage = (name) => require.resolve(`${name}/package.json`),
} = {}) => {
  const useCache = platform === process.platform && arch === process.arch;

  if (useCache && musl === undefined && cachedBinaries !== null) {
    return cachedBinaries;
  }

  const packageName = compositorPackageName({platform, arch, musl});
  let packageJson;

  try {
    packageJson = resolvePackage(packageName);
  } catch (error) {
    throw new Error(
      `Could not find ${packageName}, which provides ffmpeg for ${platform}/${arch}. Run npm install. (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const dir = dirname(packageJson);
  const binaries = {
    dir,
    ffmpeg: join(dir, executableName("ffmpeg", platform)),
    ffprobe: join(dir, executableName("ffprobe", platform)),
  };

  if (useCache && musl === undefined) {
    ensureExecutable(binaries.ffmpeg);
    ensureExecutable(binaries.ffprobe);
    cachedBinaries = binaries;
  }

  return binaries;
};
