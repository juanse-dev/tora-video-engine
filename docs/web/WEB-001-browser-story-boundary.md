# WEB-001 — Browser-compatible Story boundary

> Status: **Accepted**

## Goal

Make the Story parsing and validation boundary reusable from both Node.js and the browser without changing the v0.1 Story contract or breaking the local CLI.

## Why first

The existing \`loadStory(path)\` mixes three concerns:

1. filesystem I/O;
2. YAML parsing;
3. Zod validation.

The browser needs YAML parsing and validation but must not import \`node:fs\`.

Before adding a web app, separate the browser-safe domain logic from the Node-only file loader.

## Target boundary

~~~text
Node CLI                         Browser
   │                                │
readFile()                      text/file input
   │                                │
   └──────────────┬─────────────────┘
                  ↓
        parseStorySource()
                  ↓
              YAML parse
                  ↓
             StorySchema
                  ↓
                Story
~~~

## Scope

Implement a browser-compatible function equivalent to:

~~~ts
parseStorySource(source: string, sourceName?: string): Story
~~~

Responsibilities:

- parse YAML text;
- preserve the current malformed-YAML behavior;
- validate with \`StorySchema\`;
- return the same \`Story\` type used by the renderer;
- include useful source/path context in failures.

Refactor \`loadStory(path)\` into a thin Node-only wrapper:

~~~text
read file → parseStorySource(source, path)
~~~

No React component should import the filesystem loader.

## Compatibility requirements

The refactor must preserve:

- the exact Story schema;
- the canonical YAML fixture;
- the existing CLI render command;
- validation before rendering;
- useful field paths in validation errors;
- all current schema/timeline tests.

## Suggested structure

~~~text
src/story/
├── schema.ts
├── parseStory.ts       # browser-safe YAML + Zod boundary
├── serializeStory.ts   # browser-safe deterministic YAML output
├── loadStory.ts        # Node-only filesystem adapter
├── timeline.ts
└── types.ts
~~~

Exact filenames may differ if the separation remains explicit.

## Tests

Add coverage for \`parseStorySource()\` independent of filesystem access:

- canonical valid YAML;
- malformed YAML;
- invalid enum;
- invalid duration;
- unsupported caption text;
- source name included in useful error output;
- Story → canonical YAML → Story semantic round-trip;
- deterministic serialization for the same Story.

Keep the existing file-loader tests to prove the Node adapter still works.

## Acceptance criteria

- browser-safe Story parsing can be imported without importing any \`node:*\` module;
- \`loadStory()\` delegates parsing/validation rather than duplicating it;
- valid YAML produces the same Story object as before;
- validated Story serialization is deterministic, browser-safe, and round-trips semantically;
- invalid YAML/schema input fails before any render path;
- \`npm test\`, \`npm run lint\`, and the existing CLI render workflow remain green;
- no web UI, Player, persistence, or browser rendering is introduced in this spec.

## Out of scope

- browser file picker;
- localStorage;
- React state;
- Remotion Player;
- web bundler setup;
- MP4 rendering in the browser.

## Done when

The validated Story boundary is environment-independent, while filesystem access remains isolated to Node.
