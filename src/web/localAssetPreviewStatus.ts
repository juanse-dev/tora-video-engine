import type {StoryLocalAssetState} from "./localAssetState.ts";

type NotReady = Extract<StoryLocalAssetState, {kind: "resolved"}>["refs"];

// Corrupt is shown like missing (D-9); only "unavailable" gets its own word.
const wordFor = (entries: NotReady): "missing" | "unavailable" =>
  entries.some((entry) => entry.status !== "unavailable")
    ? "missing"
    : "unavailable";

/**
 * Short status line for refs that are not ready, e.g.
 * "2 local assets are missing in this browser. Scenes 1, 3 show placeholders."
 * Audio is reported separately (it has no placeholder: its sound is not played).
 * Returns null when every ref is ready (or there is nothing to report yet).
 */
export const describeLocalAssetPreviewStatus = (
  state: StoryLocalAssetState | undefined,
): string | null => {
  if (state?.kind !== "resolved") {
    return null;
  }

  const notReady = state.refs.filter((entry) => entry.status !== "ready");

  if (notReady.length === 0) {
    return null;
  }

  const images = notReady.filter((entry) => entry.usage.category !== "audio");
  const audio = notReady.filter((entry) => entry.usage.category === "audio");
  const sentences: string[] = [];

  if (images.length > 0) {
    const scenes = [...new Set(images.flatMap((entry) => entry.usage.sceneIndexes))]
      .sort((a, b) => a - b)
      .map((index) => index + 1);

    sentences.push(
      `${images.length} local ${images.length === 1 ? "asset is" : "assets are"} ${wordFor(images)} in this browser.`,
      scenes.length === 1
        ? `Scene ${scenes[0]} shows a placeholder.`
        : `Scenes ${scenes.join(", ")} show placeholders.`,
    );
  }

  if (audio.length > 0) {
    sentences.push(
      `${audio.length} local audio ${audio.length === 1 ? "file is" : "files are"} ${wordFor(audio)} in this browser.`,
      audio.length === 1 ? "Its sound is not played." : "Their sounds are not played.",
    );
  }

  const details = [
    ...new Set(
      [
        state.failureMessage,
        ...notReady
          .filter((entry) => entry.status === "unavailable")
          .map((entry) => entry.detail),
      ].filter((detail): detail is string => detail !== null && detail !== ""),
    ),
  ];

  return [...sentences, ...details].join(" ");
};
