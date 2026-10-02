import type {Story} from "./types";

export const exampleStory: Story = {
  title: "Deploy Friday",
  scenes: [
    {
      type: "intro",
      pose: "formal",
      background: "office",
      animation: "fade",
      text: "Tora tiene una regla: Nunca desplegar en viernes.",
      duration: 3,
    },
    {
      type: "dialogue",
      pose: "confused",
      background: "office",
      animation: "float",
      text: "Pero es solo un cambio pequeño... qué es lo peor que podría pasar?",
      duration: 3,
    },
    {
      type: "chaos",
      pose: "panic",
      background: "server-room",
      text: "Se cayó el sistema!",
      duration: 3,
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
