# WEB-004 — Discoverable asset catalog

> Status: **Accepted**

## Goal

Make the engine's available visual vocabulary obvious and selectable so the user does not need to remember pose/background/animation names.

## User-visible outcome

The editor has an “Assets disponibles” area showing actual previews of Tora poses and backgrounds, plus the supported animation choices.

Selecting an asset applies it to the active scene.

## Scope

Create a typed asset catalog for the current bundled assets.

### Tora poses

Show thumbnails for:

- \`formal\`;
- \`confused\`;
- \`panic\`;
- \`coffee\`.

### Backgrounds

Show thumbnails for:

- \`office\`;
- \`server-room\`.

### Animations

Expose:

- \`fade\`;
- \`float\`;
- \`slowZoom\`.

Also preserve the Story schema's optional animation behavior through an editor-only “Auto / scene default” choice when appropriate.

## Catalog boundary

The UI must not separately hard-code asset IDs, labels, and file paths in several components.

Prefer one typed catalog that can answer:

~~~text
asset id
display label
category
preview/static path
Story value
~~~

The existing renderer-facing mappings may be refactored to consume the same catalog if that reduces duplication without complicating rendering.

The catalog must remain consistent with the schema. TypeScript should fail or tests should fail if a new required enum value is added without corresponding asset/catalog coverage.

## Interaction

When a scene is selected:

- clicking a pose card changes that scene's pose;
- clicking a background card changes that scene's background;
- clicking an animation option changes that scene's explicit animation;
- current selections are visually indicated;
- asset changes use the same validation/commit path as the visual editor.

The asset catalog is not a separate Story state.

## Thumbnail behavior

Use the real repository assets rather than generated placeholder previews.

The catalog must load from the same static hosting origin as the app.

Background thumbnails may use cropped display styling, but the renderer continues using the original full-resolution asset.

## UX requirements

- asset categories are visually separated;
- every current pose/background can be discovered without scrolling through raw enum text;
- labels remain visible alongside imagery;
- selection state is understandable without relying only on color;
- the asset panel remains usable on normal laptop widths;
- on smaller widths it may collapse/reflow rather than forcing the preview off-screen.

## Tests

Minimum automated checks:

- every Story pose has a catalog entry;
- every Story background has a catalog entry;
- every explicit animation has an editor option;
- catalog paths correspond to the expected public asset paths;
- applying a catalog selection updates the active scene candidate.

## Acceptance criteria

- all current assets are visible in the web UI;
- pose/background cards use the actual bundled images;
- selecting an asset changes the active scene and preview;
- current scene selections are highlighted clearly;
- no duplicate asset inventory can drift independently from the domain contract;
- no new network media dependency is introduced.

## Out of scope

- asset upload;
- user-created poses/backgrounds;
- AI image generation;
- remote asset libraries;
- props/effects inventory;
- character packs.

## Done when

A first-time user can discover and apply every visual asset supported by v0.2 without consulting README documentation.
