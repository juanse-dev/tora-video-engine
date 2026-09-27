import {AbsoluteFill} from "remotion";
import {StoryRenderer} from "./StoryRenderer";
import {useCaptionFont} from "./fonts.ts";
import type {Story} from "./story/types";

export type ToraVideoProps = {
  story: Story;
};

export const ToraVideo = ({story}: ToraVideoProps) => {
  useCaptionFont(story);

  return (
    <AbsoluteFill>
      <StoryRenderer story={story} />
    </AbsoluteFill>
  );
};
