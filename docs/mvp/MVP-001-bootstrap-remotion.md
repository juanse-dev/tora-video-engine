# MVP-001 — Bootstrap Remotion

## Goal

Create the smallest runnable TypeScript + React + Remotion project and prove that the local rendering toolchain works before introducing the story engine.

## User-visible outcome

A developer can start Remotion Studio and preview a static 1080 × 1920 composition.

## Scope

Implement:

- package setup;
- TypeScript configuration;
- Remotion entry point;
- one composition named \`ToraVideo\`;
- fixed 1080 × 1920 resolution;
- fixed 30 FPS;
- temporary static frame with a background and visible text;
- npm scripts for development and a direct Remotion render smoke test.

Suggested scripts:

~~~json
{
  "scripts": {
    "dev": "remotion studio",
    "render:smoke": "remotion render ToraVideo output/smoke.mp4"
  }
}
~~~

Exact package versions and entry-point syntax should follow the Remotion version installed during implementation.

## Deliverables

At minimum:

~~~text
package.json
tsconfig.json
src/
├── Root.tsx
└── Video.tsx
~~~

Additional Remotion-generated bootstrap files are acceptable when required by the installed version.

## Implementation notes

Keep the composition static. Do not introduce YAML, Zod, scene types, asset registries or custom rendering scripts yet.

The purpose of this spec is to isolate environment/toolchain problems from engine problems.

## Acceptance criteria

- \`npm install\` succeeds from a clean checkout.
- \`npm run dev\` opens Remotion Studio without runtime errors.
- Studio exposes a composition called \`ToraVideo\`.
- The composition is 1080 × 1920 at 30 FPS.
- The preview visibly renders a temporary background and caption.
- \`npm run render:smoke\` produces a playable H.264 MP4.
- No network request is necessary during the render.

## Out of scope

- YAML;
- Zod;
- scene sequencing;
- Tora assets;
- animations;
- production render wrapper;
- tests beyond any minimal setup required by the chosen toolchain.

## Done when

The rendering environment is proven independently of all Tora Video Engine domain logic.
