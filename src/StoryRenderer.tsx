import {Sequence} from "remotion";
import {buildStoryRenderPlan} from "./renderPlan.ts";
import {Scene} from "./Scene";
import type {Timeline} from "./story/timeline.ts";

type StoryRendererProps = {
  timeline: Timeline;
};

export const StoryRenderer = ({timeline}: StoryRendererProps) => {
  const renderPlan = buildStoryRenderPlan(timeline);

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
