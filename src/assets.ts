import type {Background, Pose} from "./story/types.ts";

export const toraPoseAssets = {
  formal: "characters/tora/formal.png",
  confused: "characters/tora/confused.png",
  panic: "characters/tora/panic.png",
  coffee: "characters/tora/coffee.png",
} as const satisfies Record<Pose, string>;

export const backgroundAssets = {
  office: "backgrounds/office.png",
  "server-room": "backgrounds/server-room.png",
} as const satisfies Record<Background, string>;
