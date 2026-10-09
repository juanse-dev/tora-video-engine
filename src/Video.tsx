import {AbsoluteFill} from "remotion";
import {StoryRenderer} from "./StoryRenderer";
import {LocalAssetSourcesProvider} from "./components/visualAssetSource.tsx";
import type {LocalAssetSourceMap} from "./localAssets/sources.ts";
import {useCaptionFont} from "./fonts.ts";
import type {Story} from "./story/types";

export type ToraVideoProps = {
  story: Story;
  localAssetSources?: LocalAssetSourceMap;
};

export const ToraVideo = ({story, localAssetSources}: ToraVideoProps) => {
  const previewFontError = useCaptionFont(story);

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
        <StoryRenderer story={story} />
      </LocalAssetSourcesProvider>
    </AbsoluteFill>
  );
};
