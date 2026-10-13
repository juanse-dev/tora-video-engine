import {useMemo} from "react";
import {AbsoluteFill, useVideoConfig} from "remotion";
import {StoryRenderer} from "./StoryRenderer";
import {LocalAssetSourcesProvider} from "./components/visualAssetSource.tsx";
import type {LocalAssetSourceMap} from "./localAssets/sources.ts";
import {useCaptionFont} from "./fonts.ts";
import type {AudioDurationMap} from "./audio/catalog.ts";
import {compileTimeline} from "./story/timeline.ts";
import type {Story} from "./story/types";

export type ToraVideoProps = {
  story: Story;
  localAssetSources?: LocalAssetSourceMap;
  audioDurations?: AudioDurationMap;
};

export const ToraVideo = ({
  story,
  localAssetSources,
  audioDurations,
}: ToraVideoProps) => {
  const previewFontError = useCaptionFont(story);
  const {fps} = useVideoConfig();
  const timeline = useMemo(
    () => compileTimeline(story, fps, audioDurations ?? {}),
    [story, fps, audioDurations],
  );

  if (previewFontError !== null) {
    return (
      <AbsoluteFill
        data-preview-font-error
        role="alert"
        style={{
          alignItems: "center",
          backgroundColor: "#0a0d12",
          color: "#f8fafc",
          display: "flex",
          fontFamily: "Inter, sans-serif",
          fontSize: 48,
          justifyContent: "center",
          padding: 72,
        }}
      >
        Preview unavailable: {previewFontError.message}
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill>
      <LocalAssetSourcesProvider sources={localAssetSources}>
        <StoryRenderer timeline={timeline} />
      </LocalAssetSourcesProvider>
    </AbsoluteFill>
  );
};
