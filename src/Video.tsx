import {AbsoluteFill, useCurrentFrame} from "remotion";
import {StoryRenderer} from "./StoryRenderer";
import {useCaptionFont} from "./fonts.ts";
import type {Story} from "./story/types";

export type ToraVideoProps = {
  story: Story;
};

export const ToraVideo = ({story}: ToraVideoProps) => {
  const frame = useCurrentFrame();
  useCaptionFont(story);

  return (
    <AbsoluteFill data-tora-frame={frame}>
      <StoryRenderer story={story} />
    </AbsoluteFill>
  );
};
