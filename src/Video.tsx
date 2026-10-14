import {useMemo} from "react";
import {AbsoluteFill, useVideoConfig} from "remotion";
import {StoryRenderer} from "./StoryRenderer";
import {AudioSourcesProvider} from "./components/audioSources.tsx";
import {StoryAudio} from "./components/StoryAudio.tsx";
import {LocalAssetSourcesProvider} from "./components/visualAssetSource.tsx";
import type {LocalAssetSourceMap} from "./localAssets/sources.ts";
import {useCaptionFont} from "./fonts.ts";
import type {AudioDurationMap} from "./audio/catalog.ts";
import type {AudioSourceMap, BundledAudioPolicy} from "./audio/sources.ts";
import {compileTimeline} from "./story/timeline.ts";
import type {Story} from "./story/types";

export type ToraVideoProps = {
  story: Story;
  localAssetSources?: LocalAssetSourceMap;
  audioDurations?: AudioDurationMap;
  audioSources?: AudioSourceMap;
  /** Studio only; the Player and both renderers pass explicit sources. Default "static-fallback". */
  bundledAudioPolicy?: BundledAudioPolicy;
  /** `StoryAudio` mounts no `<Audio>` only when this is exactly `false` (only the Player's Preview passes it). */
  audioArmed?: boolean;
};

export const ToraVideo = ({
  story,
  localAssetSources,
  audioDurations,
  audioSources,
  bundledAudioPolicy,
  audioArmed,
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
        <AudioSourcesProvider
          sources={audioSources}
          policy={bundledAudioPolicy ?? "static-fallback"}
        >
          <StoryAudio
            story={story}
            timeline={timeline}
            fps={fps}
            audioDurations={audioDurations}
            audioArmed={audioArmed}
          />
        </AudioSourcesProvider>
      </LocalAssetSourcesProvider>
    </AbsoluteFill>
  );
};
