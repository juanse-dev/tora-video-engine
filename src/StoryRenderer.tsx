import {Sequence, useVideoConfig} from "remotion";
import {buildStoryRenderPlan} from "./renderPlan.ts";
import {Scene} from "./Scene";
import type {Story} from "./story/types";

type StoryRendererProps = {
  story: Story;
};

export const StoryRenderer = ({story}: StoryRendererProps) => {
  const {fps} = useVideoConfig();
  const renderPlan = buildStoryRenderPlan(story, fps);

  return (
    <>
      {renderPlan.scenes.map((scene, index) => (
        <Sequence
          key={`${scene.from}-${index}`}
          from={scene.from}
          durationInFrames={scene.durationInFrames}
          name={`${index + 1}. ${scene.type}`}
        >
          <Scene scene={scene} />
        </Sequence>
      ))}
    </>
  );
};
