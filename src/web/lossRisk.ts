import type {ProtectedRecovery} from "./persistence.ts";
import type {VisualApplicationState} from "./authoringState.ts";
import type {YamlEditorState} from "./yamlState.ts";
import {isYamlDirty} from "./yamlState.ts";

export type LossRiskInput = {
  visual: VisualApplicationState;
  yaml: YamlEditorState | null;
  recovery: ProtectedRecovery | null;
  activeStoryDurable: boolean;
};

export const hasLossRisk = ({
  visual,
  yaml,
  activeStoryDurable,
}: LossRiskInput): boolean =>
  visual.pending ||
  (yaml !== null &&
    (isYamlDirty(yaml) || yaml.transferSnapshot !== null)) ||
  !activeStoryDurable;

export const installBeforeUnloadGuard = (
  windowRef: Window,
  shouldBlock: () => boolean,
): (() => void) => {
  const handler = (event: BeforeUnloadEvent) => {
    if (!shouldBlock()) {
      return;
    }

    event.preventDefault();
    event.returnValue = "";
  };

  windowRef.addEventListener("beforeunload", handler);

  return () => {
    windowRef.removeEventListener("beforeunload", handler);
  };
};
