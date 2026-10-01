import type {Story} from "../story/types.ts";
import type {
  VisualDraftErrors,
  VisualDraftEvaluation,
} from "./visualDraft.ts";
import type {BrowserStoryPolicyResult} from "./browserPolicy.ts";

export type VisualApplicationState =
  | {
      kind: "clean";
      pending: false;
      candidate: null;
      errors: VisualDraftErrors;
    }
  | {
      kind: "schema-invalid";
      pending: true;
      candidate: null;
      errors: VisualDraftErrors;
    }
  | {
      kind: "policy-rejected";
      pending: true;
      candidate: Story;
      policy: Extract<BrowserStoryPolicyResult, {eligible: false}>;
      errors: VisualDraftErrors;
    };

export type AuthoringState = {
  activeStory: Story;
  visual: VisualApplicationState;
};

export const createAuthoringState = (activeStory: Story): AuthoringState => ({
  activeStory,
  visual: {
    kind: "clean",
    pending: false,
    candidate: null,
    errors: {},
  },
});

export const applyVisualDraftEvaluation = (
  state: AuthoringState,
  evaluation: VisualDraftEvaluation,
): AuthoringState => {
  if (evaluation.kind === "eligible") {
    return {
      activeStory: evaluation.story,
      visual: {
        kind: "clean",
        pending: false,
        candidate: null,
        errors: {},
      },
    };
  }

  if (evaluation.kind === "policy-rejected") {
    return {
      activeStory: state.activeStory,
      visual: {
        kind: "policy-rejected",
        pending: true,
        candidate: evaluation.story,
        policy: evaluation.policy,
        errors: evaluation.errors,
      },
    };
  }

  return {
    activeStory: state.activeStory,
    visual: {
      kind: "schema-invalid",
      pending: true,
      candidate: null,
      errors: evaluation.errors,
    },
  };
};
