import type {Story} from "./types";

export const exampleStory: Story = {
  title: "Deploy Friday",
  scenes: [
    {
      type: "intro",
      pose: "formal",
      background: "office",
      animation: "fade",
      text: "Tora tiene una regla.",
      duration: 3,
    },
    {
      type: "dialogue",
      pose: "confused",
      background: "office",
      animation: "float",
      text: "Pero es solo un cambio pequeño...",
      duration: 2,
    },
    {
      type: "chaos",
      pose: "panic",
      background: "server-room",
      text: "Production is down.",
      duration: 4,
    },
    {
      type: "punchline",
      pose: "coffee",
      background: "office",
      animation: "slowZoom",
      text: "Era un cambio pequeño.",
      duration: 3,
    },
  ],
};
