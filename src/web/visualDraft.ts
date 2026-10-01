import {
  animations,
  backgrounds,
  poses,
  sceneTypes,
  StorySchema,
  type Animation,
  type Background,
  type Pose,
  type SceneType,
  type Story,
} from "../story/schema.ts";
import {
  evaluateBrowserStoryPolicy,
  MAX_BROWSER_TITLE_CODE_UNITS,
  MAX_VISUAL_CAPTION_CODE_UNITS,
  MAX_VISUAL_DRAFT_SCENES,
  type BrowserStoryPolicyResult,
} from "./browserPolicy.ts";

export type VisualSceneDraft = {
  type: SceneType;
  pose: Pose;
  background: Background;
  animation: Animation | "";
  text: string;
  duration: string;
};

export type VisualStoryDraft = {
  title: string;
  scenes: VisualSceneDraft[];
};

export type VisualDraftErrors = Record<string, string>;

export type VisualDraftEvaluation =
  | {
      kind: "eligible";
      story: Story;
      policy: Extract<BrowserStoryPolicyResult, {eligible: true}>;
      errors: VisualDraftErrors;
    }
  | {
      kind: "schema-invalid";
      errors: VisualDraftErrors;
    }
  | {
      kind: "policy-rejected";
      story: Story;
      policy: Extract<BrowserStoryPolicyResult, {eligible: false}>;
      errors: VisualDraftErrors;
    };

export const visualEditorOptions = {
  sceneTypes,
  poses,
  backgrounds,
  animations,
} as const;

export const DEFAULT_VISUAL_SCENE: VisualSceneDraft = {
  type: "intro",
  pose: "formal",
  background: "office",
  animation: "",
  text: "New scene",
  duration: "3",
};

export const storyToVisualDraft = (story: Story): VisualStoryDraft => ({
  title: story.title,
  scenes: story.scenes.map((scene) => ({
    type: scene.type,
    pose: scene.pose,
    background: scene.background,
    animation: scene.animation ?? "",
    text: scene.text,
    duration: String(scene.duration),
  })),
});

const durationFromInput = (value: string): number =>
  value.trim().length === 0 ? Number.NaN : Number(value);

const visualDraftToCandidate = (draft: VisualStoryDraft): unknown => ({
  title: draft.title,
  scenes: draft.scenes.map((scene) => ({
    type: scene.type,
    pose: scene.pose,
    background: scene.background,
    ...(scene.animation === "" ? {} : {animation: scene.animation}),
    text: scene.text,
    duration: durationFromInput(scene.duration),
  })),
});

const mapSchemaIssues = (
  issues: readonly {path: PropertyKey[]; message: string}[],
): VisualDraftErrors => {
  const errors: VisualDraftErrors = {};

  for (const issue of issues) {
    const path =
      issue.path.length === 0 ? "_form" : issue.path.map(String).join(".");

    errors[path] ??= issue.message;
  }

  return errors;
};

export const evaluateVisualDraft = (
  draft: VisualStoryDraft,
  policy: (story: Story) => BrowserStoryPolicyResult =
    evaluateBrowserStoryPolicy,
): VisualDraftEvaluation => {
  const parsed = StorySchema.safeParse(visualDraftToCandidate(draft));

  if (!parsed.success) {
    return {
      kind: "schema-invalid",
      errors: mapSchemaIssues(parsed.error.issues),
    };
  }

  const policyResult = policy(parsed.data);

  if (!policyResult.eligible) {
    return {
      kind: "policy-rejected",
      story: parsed.data,
      policy: policyResult,
      errors: {
        _form: policyResult.message,
      },
    };
  }

  return {
    kind: "eligible",
    story: parsed.data,
    policy: policyResult,
    errors: {},
  };
};

export const validateRawVisualTitle = (title: string): string | null =>
  title.length > MAX_BROWSER_TITLE_CODE_UNITS
    ? "Title exceeds the browser editor limit of 65,536 UTF-16 code units. The oversized input was not accepted; use YAML/CLI for larger titles."
    : null;

export const validateRawVisualCaption = (text: string): string | null =>
  text.length > MAX_VISUAL_CAPTION_CODE_UNITS
    ? "Caption exceeds the 360 UTF-16 code-unit visual input guard. The oversized input was not accepted."
    : null;

export const canAddVisualScene = (draft: VisualStoryDraft): boolean =>
  draft.scenes.length < MAX_VISUAL_DRAFT_SCENES;

export const addVisualScene = (
  draft: VisualStoryDraft,
): VisualStoryDraft => {
  if (!canAddVisualScene(draft)) {
    return draft;
  }

  return {
    ...draft,
    scenes: [...draft.scenes, {...DEFAULT_VISUAL_SCENE}],
  };
};

export const deleteVisualScene = (
  draft: VisualStoryDraft,
  index: number,
): VisualStoryDraft => {
  if (draft.scenes.length <= 1) {
    return draft;
  }

  return {
    ...draft,
    scenes: draft.scenes.filter((_, sceneIndex) => sceneIndex !== index),
  };
};

export const moveVisualScene = (
  draft: VisualStoryDraft,
  from: number,
  to: number,
): VisualStoryDraft => {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= draft.scenes.length ||
    to >= draft.scenes.length
  ) {
    return draft;
  }

  const scenes = [...draft.scenes];
  const [scene] = scenes.splice(from, 1);
  scenes.splice(to, 0, scene);

  return {
    ...draft,
    scenes,
  };
};

export type VisualYamlTransitionAction =
  | "open-active-in-yaml"
  | "open-candidate-in-yaml"
  | "discard"
  | "stay";

export const getVisualYamlTransitionActions = (
  evaluation: VisualDraftEvaluation,
): readonly VisualYamlTransitionAction[] => {
  if (evaluation.kind === "schema-invalid") {
    return ["discard", "stay"];
  }

  if (evaluation.kind === "policy-rejected") {
    return ["open-candidate-in-yaml", "discard", "stay"];
  }

  return ["open-active-in-yaml"];
};
