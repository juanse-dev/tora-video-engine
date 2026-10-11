# WEB-002 — Static web shell and Remotion Player

> Status: **Accepted**

## Goal

Add the smallest static React web application that can display the canonical Tora composition in a browser using the existing renderer components.

## User-visible outcome

A developer can run a web development command, open Tora Video Engine in a normal browser, and play/pause the canonical 9:16 story inside a Remotion Player.

There is no editor yet.

## Scope

Add a static web build using a lightweight browser bundler such as Vite.

Provide scripts equivalent to:

~~~json
{
  "scripts": {
    "web:dev": "...",
    "web:build": "...",
    "web:preview": "..."
  }
}
~~~

Add \`@remotion/player\` at the exact Remotion version already pinned by the repository.

The web shell should contain:

- a Tora Video Engine header;
- a main content area;
- one responsive 9:16 preview;
- basic Player controls (play/pause, seek bar, time, fullscreen) with no volume controls (see Muted Player);
- the canonical/example Story passed as \`inputProps\`.

## Muted Player

Tora Stories are video-only. The Player is rendered with \`initiallyMuted\` and \`showVolumeControls={false}\`, so it starts muted and offers no mute button or volume slider.

This is also a correctness requirement (issue #24). \`@remotion/player\` 4.0.529 makes an unmuted Player wait for the shared \`AudioContext\` to resume before it advances. If \`AudioContext.resume()\` never settles, for example on a machine with no audio device, playback freezes at the current frame while the button shows "Pause video". A muted Player skips that wait, and the \`AudioContext\` is not created at all.

Do not add volume controls or unmute the Player unless Stories gain an audio track.

## Shared rendering requirement

The Player must reuse the production composition/component path.

Do not create a simplified “web preview renderer” that reimplements scenes separately.

Conceptually:

~~~text
exampleStory
    ↓
ToraVideo / StoryRenderer / Scene
    ↓
@remotion/player
~~~

The CLI continues using the same rendering components through Remotion CLI.

## Video metadata

Player dimensions, FPS, and duration must come from the existing video/story metadata helpers rather than duplicated magic numbers.

The canonical fixture should therefore display the same:

- 1080 × 1920 composition ratio;
- 30 FPS;
- derived frame duration.

The browser may scale the visual Player responsively; composition coordinates remain unchanged.

## Static assets

The Player must resolve the existing image assets from `public/`:

- all four Tora poses;
- office;
- server-room.

The caption font follows a different existing path: `src/fonts.ts` imports `@fontsource-variable/inter/wght.css`, and the current font-loading logic uses that bundled dependency. The web bundler must preserve that path rather than treating the font as a file under `public/`.

Do not add duplicate image assets or copy font files into `public/` for the web app.

## Suggested structure

~~~text
src/web/
├── App.tsx
├── main.tsx
└── components/
    └── Preview.tsx

index.html
vite.config.ts
~~~

Exact placement may differ if the build remains clearly separated from the Remotion Studio entry point.

## Acceptance criteria

- \`npm run web:dev\` opens the web app;
- \`npm run web:build\` produces a static build artifact;
- the canonical story is visible and playable in a Remotion Player;
- Player duration matches the canonical compiled Story duration;
- the Player starts muted and shows no volume controls, and playback advances even when \`AudioContext.resume()\` never settles;
- Tora images, backgrounds, captions, and animations render correctly;
- the caption font is bundled through the existing \`@fontsource-variable/inter\` import/font-loading path rather than duplicated under \`public/\`;
- resizing the browser does not change composition semantics or crop the Player controls unexpectedly;
- existing \`npm run dev\` still opens Remotion Studio;
- existing \`npm run video -- stories/friday-deploy.yaml\` still renders successfully;
- all Remotion packages use one exact version.

## Out of scope

- scene editing;
- asset browser;
- YAML editor;
- persistence;
- import/export;
- MP4 browser rendering;
- deployment configuration.

## Done when

The repository has two working presentation surfaces over the same renderer: Remotion Studio and a static web Player.
