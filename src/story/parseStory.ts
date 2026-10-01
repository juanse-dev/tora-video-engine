import YAML from "yaml";
import {StorySchema, type Story} from "./schema.ts";

const messageFromUnknown = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const formatPath = (path: PropertyKey[]): string =>
  path.length === 0 ? "<root>" : path.map(String).join(".");

const sourceSuffix = (sourceName?: string): string =>
  sourceName === undefined ? "" : ` "${sourceName}"`;

export const parseStorySource = (
  source: string,
  sourceName?: string,
): Story => {
  let parsed: unknown;

  try {
    const document = YAML.parseDocument(source);

    if (document.errors.length > 0) {
      throw new Error(document.errors.map((error) => error.message).join("; "));
    }

    parsed = document.toJS();
  } catch (error) {
    throw new Error(
      `Failed to parse YAML${sourceSuffix(sourceName)}: ${messageFromUnknown(error)}`,
    );
  }

  const result = StorySchema.safeParse(parsed);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${formatPath(issue.path)}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `Invalid story${sourceSuffix(sourceName)}:\n${details}`,
    );
  }

  return result.data;
};
