import {readFile} from "node:fs/promises";
import {parseStorySource} from "./parseStory.ts";
import type {Story} from "./schema.ts";

const messageFromUnknown = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const loadStory = async (path: string): Promise<Story> => {
  let source: string;

  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read story "${path}": ${messageFromUnknown(error)}`,
    );
  }

  return parseStorySource(source, path);
};
