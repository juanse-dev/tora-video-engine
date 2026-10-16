export type FfmpegBinaries = {dir: string; ffmpeg: string; ffprobe: string};

/**
 * Name of the npm package that holds ffmpeg/ffprobe for a platform, e.g.
 * `@remotion/compositor-win32-x64-msvc` or `@remotion/compositor-linux-x64-gnu`.
 */
export function compositorPackageName(options?: {
  platform?: string;
  arch?: string;
  musl?: boolean;
}): string;

/**
 * `{dir, ffmpeg, ffprobe}`: absolute paths from the installed compositor
 * package. `resolvePackage` replaces module resolution (tests).
 */
export function resolveFfmpegBinaries(options?: {
  platform?: string;
  arch?: string;
  musl?: boolean;
  resolvePackage?: (packageName: string) => string;
}): FfmpegBinaries;
