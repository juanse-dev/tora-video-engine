import {parseStorySource} from "../story/parseStory.ts";
import {serializeStorySource} from "../story/serializeStory.ts";
import type {Story} from "../story/types.ts";
import {
  evaluateBrowserStoryPolicy,
  type BrowserStoryPolicyResult,
} from "./browserPolicy.ts";

export const MAX_BROWSER_YAML_SOURCE_BYTES = 1_048_576;
export const MAX_BROWSER_YAML_SOURCE_CODE_UNITS = 1_048_576;

export type YamlValidation =
  | {kind: "eligible"; story: Story; policy: Extract<BrowserStoryPolicyResult, {eligible: true}>}
  | {kind: "policy-rejected"; story: Story; policy: Extract<BrowserStoryPolicyResult, {eligible: false}>}
  | {kind: "parse-invalid"; message: string}
  | {kind: "schema-invalid"; message: string}
  | {kind: "source-oversized"; message: string};

export type YamlTransferSnapshot = {
  story: Story;
  buffer: string;
};

export type YamlEditorState = {
  buffer: string;
  baseline: string;
  validation: YamlValidation;
  transferSnapshot: YamlTransferSnapshot | null;
  sourceGuardMessage: string | null;
};

export type YamlEvaluationDependencies = {
  utf8ByteLength?: (source: string) => number;
  parse?: (source: string, sourceName?: string) => Story;
  policy?: (story: Story) => BrowserStoryPolicyResult;
};

const defaultUtf8ByteLength = (source: string): number =>
  new TextEncoder().encode(source).byteLength;

export const evaluateYamlSource = (
  source: string,
  sourceName = "browser.yaml",
  dependencies: YamlEvaluationDependencies = {},
): YamlValidation => {
  const utf8ByteLength =
    dependencies.utf8ByteLength ?? defaultUtf8ByteLength;

  if (utf8ByteLength(source) > MAX_BROWSER_YAML_SOURCE_BYTES) {
    return {
      kind: "source-oversized",
      message:
        "YAML source exceeds the 1 MiB browser limit. Use the CLI for this document.",
    };
  }

  const parse = dependencies.parse ?? parseStorySource;
  let story: Story;

  try {
    story = parse(source, sourceName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return message.startsWith("Failed to parse YAML")
      ? {kind: "parse-invalid", message}
      : {kind: "schema-invalid", message};
  }

  const policy = dependencies.policy ?? evaluateBrowserStoryPolicy;
  const policyResult = policy(story);

  if (!policyResult.eligible) {
    return {
      kind: "policy-rejected",
      story,
      policy: policyResult,
    };
  }

  return {
    kind: "eligible",
    story,
    policy: policyResult,
  };
};

export const createYamlStateFromActiveStory = (
  story: Story,
): YamlEditorState => {
  const buffer = serializeStorySource(story);

  return {
    buffer,
    baseline: buffer,
    validation: evaluateYamlSource(buffer, "active-story.yaml"),
    transferSnapshot: null,
    sourceGuardMessage: null,
  };
};

export const createYamlStateFromTransferredCandidate = (
  activeStory: Story,
  candidate: Story,
): YamlEditorState => {
  const baseline = serializeStorySource(activeStory);
  const buffer = serializeStorySource(candidate);

  if (buffer.length > MAX_BROWSER_YAML_SOURCE_CODE_UNITS) {
    throw new Error(
      "Transferred candidate exceeds the browser YAML code-unit ceiling.",
    );
  }

  const validation = evaluateYamlSource(
    buffer,
    "transferred-candidate.yaml",
  );

  if (validation.kind === "source-oversized") {
    throw new Error(
      "Transferred candidate exceeds the browser YAML source-size ceiling.",
    );
  }

  return {
    buffer,
    baseline,
    validation,
    transferSnapshot: {
      story: candidate,
      buffer,
    },
    sourceGuardMessage: null,
  };
};

export const isYamlDirty = (state: YamlEditorState): boolean =>
  state.buffer !== state.baseline;

export const tryEditYamlBuffer = (
  state: YamlEditorState,
  nextBuffer: string,
  dependencies: YamlEvaluationDependencies = {},
):
  | {accepted: true; state: YamlEditorState}
  | {accepted: false; state: YamlEditorState; message: string} => {
  if (nextBuffer.length > MAX_BROWSER_YAML_SOURCE_CODE_UNITS) {
    const message =
      "YAML edit exceeds the 1 MiB UTF-16 precheck and was not accepted.";

    return {
      accepted: false,
      state: {...state, sourceGuardMessage: message},
      message,
    };
  }

  const validation = evaluateYamlSource(
    nextBuffer,
    "editor.yaml",
    dependencies,
  );

  if (validation.kind === "source-oversized") {
    return {
      accepted: false,
      state: {
        ...state,
        sourceGuardMessage: validation.message,
      },
      message: validation.message,
    };
  }

  return {
    accepted: true,
    state: {
      ...state,
      buffer: nextBuffer,
      validation,
      transferSnapshot:
        state.transferSnapshot?.buffer === nextBuffer
          ? state.transferSnapshot
          : null,
      sourceGuardMessage: null,
    },
  };
};

export const applyYamlState = (
  state: YamlEditorState,
):
  | {applied: true; story: Story; state: YamlEditorState}
  | {applied: false; state: YamlEditorState} => {
  if (state.validation.kind !== "eligible") {
    return {applied: false, state};
  }

  return {
    applied: true,
    story: state.validation.story,
    state: {
      ...state,
      baseline: state.buffer,
      transferSnapshot: null,
      sourceGuardMessage: null,
    },
  };
};

export const canExportYamlCandidate = (
  state: YamlEditorState,
): boolean =>
  state.validation.kind === "eligible" ||
  state.validation.kind === "policy-rejected" ||
  (state.transferSnapshot !== null &&
    state.transferSnapshot.buffer === state.buffer);

export const getYamlCandidateStory = (
  state: YamlEditorState,
): Story | null => {
  if (
    state.validation.kind === "eligible" ||
    state.validation.kind === "policy-rejected"
  ) {
    return state.validation.story;
  }

  if (
    state.transferSnapshot !== null &&
    state.transferSnapshot.buffer === state.buffer
  ) {
    return state.transferSnapshot.story;
  }

  return null;
};
