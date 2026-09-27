import {basename, extname, join, resolve} from "node:path";

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

export const getRemotionCliPath = (): string =>
  resolve(
    "node_modules",
    "@remotion",
    "cli",
    "remotion-cli.js",
  );

export const buildRenderArgs = (
  outputPath: string,
  propsPath: string,
): string[] => [
  getRemotionCliPath(),
  "render",
  REMOTION_ENTRY_POINT,
  COMPOSITION_ID,
  outputPath,
  "--codec=h264",
  "--overwrite=true",
  `--props=${propsPath}`,
];
