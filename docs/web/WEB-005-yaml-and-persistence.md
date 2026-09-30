# WEB-005 — YAML workflow and local persistence

> Status: **Proposed**

## Goal

Preserve YAML as a first-class external format while making the web editor local-first and safe against invalid text.

## User-visible outcome

A user can:

- switch between visual authoring and YAML;
- import an existing Story YAML file;
- validate YAML with useful errors;
- apply valid YAML to the visual editor and preview;
- export the current valid Story as YAML;
- reload the page and recover the last valid project.

## YAML editing model

Do not make raw YAML text the live render source while the user is typing.

Use a draft buffer:

~~~text
YAML text buffer
      ↓
parseStorySource()
      ↓
valid? ── no → show errors, keep current validated Story
  │
 yes
  ↓
Apply
  ↓
Validated Story
~~~

An explicit “Apply YAML” action is preferred for v0.2 because it avoids replacing a user's text/cursor position while still preserving one authoritative Story for preview/render.

## Visual ↔ YAML behavior

### Enter YAML mode

Generate a canonical YAML representation from the current validated Story.

Exact whitespace/comments from an originally imported file do not need to be preserved.

### Edit YAML

- validate on demand or live with debounce;
- show parse/schema errors with useful paths/context;
- do not update preview/render state until valid YAML is applied.

### Apply valid YAML

- replace the validated Story;
- update the visual editor;
- update preview;
- persist the new valid Story.

### Return to visual mode with invalid YAML

Do not silently apply invalid text.

The invalid YAML buffer may remain available if the user returns to YAML mode, but the visual editor continues showing the last validated Story.

## Import

Support a browser file input for \`.yaml\` / \`.yml\`.

Imported text must go through the same parser and validator as pasted/edited YAML.

No separate import schema is allowed.

## Export

Serialize the current validated Story to deterministic, human-readable YAML and download it with a stable filename derived from the Story title or a documented fallback.

Serialization is a representation concern; it must not change Story semantics.

## Persistence

Use browser-local persistence for the MVP.

Prefer \`localStorage\` because the current Story payload is small and contains no binary assets.

Persist:

- a small storage/schema version;
- the last validated Story.

Do not persist an invalid Story as the recoverable project.

On startup:

1. attempt to load stored data;
2. validate it with the current Story schema;
3. if valid, restore it;
4. if invalid/corrupt/unavailable, fall back safely to the canonical/example Story.

## Reset

Provide a clear way to reset the local project to the canonical/default Story.

## Tests

Cover:

- Story → YAML → Story semantic round-trip;
- invalid YAML does not replace validated Story;
- imported valid YAML updates the Story;
- corrupt localStorage falls back safely;
- valid localStorage restores;
- schema-invalid stored data is rejected;
- reset restores the default Story.

## Acceptance criteria

- visual and YAML modes operate on one validated Story;
- YAML can be imported and exported entirely in-browser;
- invalid YAML never reaches preview/render/persistence;
- valid YAML round-trips without semantic loss;
- page reload restores the last valid Story;
- persistence requires no backend, account, or database;
- CLI YAML files remain compatible with the web app.

## Out of scope

- preserving YAML comments/formatting byte-for-byte;
- autosave history/versioning;
- cloud sync;
- collaboration;
- IndexedDB;
- project libraries with multiple named projects.

## Done when

YAML remains a portable contract between CLI and browser, while the browser safely restores the user's latest valid work.
