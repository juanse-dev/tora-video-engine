import {Player, type PlayerRef} from "@remotion/player";
import {useEffect, useMemo, useRef} from "react";
import type {LocalAssetSourceMap} from "../../localAssets/sources.ts";
import {ToraVideo} from "../../Video.tsx";
import {exampleStory} from "../../story/exampleStory.ts";
import type {Story} from "../../story/types.ts";
import type {StoryLocalAssetState} from "../localAssetState.ts";
import {getWebPlayerConfig} from "../previewConfig.ts";

type PreviewProps = {
  story?: Story;
  localAssetSources?: LocalAssetSourceMap;
  localAssetState?: StoryLocalAssetState;
};

/**
 * Short status line for refs that are not ready, e.g.
 * "2 local assets are missing in this browser. Scenes 1, 3 show placeholders."
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

  // Corrupt is shown like missing (D-9); only "unavailable" gets its own word.
  const word = notReady.some((entry) => entry.status !== "unavailable")
    ? "missing"
    : "unavailable";
  const scenes = [
    ...new Set(notReady.flatMap((entry) => entry.usage.sceneIndexes)),
  ]
    .sort((a, b) => a - b)
    .map((index) => index + 1);
  const count = notReady.length;
  const sentences = [
    `${count} local ${count === 1 ? "asset is" : "assets are"} ${word} in this browser.`,
    scenes.length === 1
      ? `Scene ${scenes[0]} shows a placeholder.`
      : `Scenes ${scenes.join(", ")} show placeholders.`,
  ];
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

export const Preview = ({
  story = exampleStory,
  localAssetSources,
  localAssetState,
}: PreviewProps) => {
  const config = getWebPlayerConfig(story);
  const playerRef = useRef<PlayerRef>(null);
  const frameProbeRef = useRef<HTMLDivElement>(null);
  const overBudget = localAssetState?.kind === "over-budget";
  const inputProps = useMemo(
    () => ({story, localAssetSources}),
    [story, localAssetSources],
  );
  const statusLine = describeLocalAssetPreviewStatus(localAssetState);

  useEffect(() => {
    const player = playerRef.current;

    if (player === null) {
      return;
    }

    const onFrameUpdate = ({detail}: {detail: {frame: number}}) => {
      if (frameProbeRef.current !== null) {
        frameProbeRef.current.dataset.toraFrame = String(detail.frame);
      }
    };

    player.addEventListener("frameupdate", onFrameUpdate);

    return () => {
      player.removeEventListener("frameupdate", onFrameUpdate);
    };
  }, [overBudget]);

  if (localAssetState?.kind === "over-budget") {
    return (
      <div className="preview-frame">
        <div data-local-asset-over-budget role="status">
          {localAssetState.message}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={frameProbeRef}
      className="preview-frame"
      data-tora-frame="0"
    >
      <Player
        ref={playerRef}
        component={ToraVideo}
        inputProps={inputProps}
        durationInFrames={config.durationInFrames}
        fps={config.fps}
        compositionWidth={config.compositionWidth}
        compositionHeight={config.compositionHeight}
        controls
        errorFallback={({error}) => (
          <div data-preview-error role="alert">
            Preview unavailable: {error.message}
          </div>
        )}
        style={{
          width: "100%",
        }}
      />
      {statusLine !== null ? (
        <p data-local-asset-status>{statusLine}</p>
      ) : null}
    </div>
  );
};
