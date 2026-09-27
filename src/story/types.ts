export type SceneType = "intro" | "dialogue" | "chaos" | "punchline";

export type Pose = "formal" | "confused" | "panic" | "coffee";

export type Background = "office" | "server-room";

export type Animation = "fade" | "float" | "slowZoom";

export type StoryScene = {
  type: SceneType;
  pose: Pose;
  background: Background;
  text: string;
  duration: number;
  animation?: Animation;
};

export type Story = {
  title: string;
  scenes: StoryScene[];
};
