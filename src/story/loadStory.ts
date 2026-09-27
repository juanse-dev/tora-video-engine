import {readFile} from "node:fs/promises";
import YAML from "yaml";
import {StorySchema, type Story} from "./schema.ts";

const messageFromUnknown = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const formatPath = (path: PropertyKey[]): string => {
  return path.length === 0 ? "<root>" : path.map(String).join(".");
};

export const loadStory = async (path: string): Promise<Story> => {
  let source: string;

  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read story "${path}": ${messageFromUnknown(error)}`,
    );
  }

  let parsed: unknown;

  try {
    const document = YAML.parseDocument(source);

    if (document.errors.length > 0) {
      throw new Error(document.errors.map((error) => error.message).join("; "));
    }

    parsed = document.toJS();
  } catch (error) {
    throw new Error(
      `Failed to parse YAML "${path}": ${messageFromUnknown(error)}`,
    );
  }

  const result = StorySchema.safeParse(parsed);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${formatPath(issue.path)}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid story "${path}":\n${details}`);
  }

  return result.data;
};
