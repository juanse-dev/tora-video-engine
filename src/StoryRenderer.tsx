import {Sequence, useVideoConfig} from "remotion";
import {Scene} from "./Scene";
import {compileTimeline} from "./story/timeline";
import type {Story} from "./story/types";

type StoryRendererProps = {
  story: Story;
};

export const StoryRenderer = ({story}: StoryRendererProps) => {
  const {fps} = useVideoConfig();
  const timeline = compileTimeline(story, fps);

  return (
    <>
      {timeline.scenes.map((scene, index) => (
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
