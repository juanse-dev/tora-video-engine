import {AbsoluteFill} from "remotion";
import {StoryRenderer} from "./StoryRenderer";
import {useCaptionFont} from "./fonts.ts";
import type {Story} from "./story/types";

export type ToraVideoProps = {
  story: Story;
};

export const ToraVideo = ({story}: ToraVideoProps) => {
  const previewFontError = useCaptionFont(story);

  if (previewFontError !== null) {
    return (
      <AbsoluteFill
        data-preview-font-error
        role="alert"
        style={{
          alignItems: "center",
          background: "#0a0d12",
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
      <StoryRenderer story={story} />
    </AbsoluteFill>
  );
};
