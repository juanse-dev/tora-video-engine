import {AbsoluteFill} from "remotion";
import {StoryRenderer} from "./StoryRenderer";
import type {Story} from "./story/types";

export type ToraVideoProps = {
  story: Story;
};

export const ToraVideo = ({story}: ToraVideoProps) => {
  return (
    <AbsoluteFill>
      <StoryRenderer story={story} />
    </AbsoluteFill>
  );
};
