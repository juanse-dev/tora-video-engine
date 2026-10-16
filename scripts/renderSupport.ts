import {basename, extname, join, resolve} from "node:path";
import {OUTPUT_AUDIO_BITRATE} from "../src/audio/constants.ts";

export const COMPOSITION_ID = "ToraVideo";
export const REMOTION_ENTRY_POINT = "src/index.ts";

export const getStoryPath = (args: string[]): string => {
  if (args.length === 0) {
    throw new Error(
      "Missing story path. Usage: npm run video -- path/to/story.yaml",
    );
  }

  if (args.length > 1) {
    throw new Error(
      "Expected exactly one story path. Usage: npm run video -- path/to/story.yaml",
    );
  }

  return args[0];
};

export const getStorySlug = (storyPath: string): string => {
  const extension = extname(storyPath);
  const filename = basename(storyPath, extension);
  const slug = filename
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  if (slug.length === 0) {
    throw new Error(
      `Could not derive an output filename from story path "${storyPath}"`,
    );
  }

  return slug;
};

export const getOutputPath = (storyPath: string): string =>
  join("output", `${getStorySlug(storyPath)}.mp4`);

export const getRemotionExecutable = (): string => process.execPath;

export const getRemotionBrowserExecutable = (): string | null => {
  const executable =
    process.env.TORA_REMOTION_BROWSER_EXECUTABLE?.trim();

  return executable ? executable : null;
};

export const getRemotionCliPath = (): string =>
  resolve(
    "node_modules",
    "@remotion",
    "cli",
    "remotion-cli.js",
  );

/**
 * D-14: the AAC arguments of a render with audio. A Story without audio never
 * gets them, so its argument list is exactly the v0.3 one (AINV-6).
 * `--enforce-audio-track` (the CLI flag of Remotion's `enforceAudioTrack`) keeps one AAC
 * track when the mix is inaudible (every track at volume 0): without it Remotion
 * drops the silent audio and writes a video-only file, while the browser always
 * writes the track (AINV-9).
 */
export const AUDIO_RENDER_ARGS = [
  "--audio-codec=aac",
  `--audio-bitrate=${OUTPUT_AUDIO_BITRATE / 1000}k`,
  "--enforce-audio-track",
] as const;

export const buildRenderArgs = (
  outputPath: string,
  propsPath: string,
  publicDir?: string,
  options: {hasAudio?: boolean} = {},
): string[] => {
  const browserExecutable = getRemotionBrowserExecutable();

  return [
    getRemotionCliPath(),
    "render",
    REMOTION_ENTRY_POINT,
    COMPOSITION_ID,
    outputPath,
    "--codec=h264",
    "--overwrite=true",
    `--props=${propsPath}`,
    ...(browserExecutable === null
      ? []
      : [`--browser-executable=${browserExecutable}`]),
    ...(publicDir === undefined ? [] : [`--public-dir=${publicDir}`]),
    ...(options.hasAudio === true ? AUDIO_RENDER_ARGS : []),
  ];
};
