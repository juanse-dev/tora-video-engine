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

If a YAML draft buffer with unapplied changes already exists in the current editor session, restore that buffer exactly as the user left it.

Only generate a fresh canonical YAML representation from the current validated Story when there is no retained unapplied YAML buffer.

This prevents switching visual → YAML → visual → YAML from silently overwriting work that has not been applied or explicitly discarded.

Exact whitespace/comments from an originally imported file do not need to be preserved after the YAML has been successfully applied and later regenerated from the validated Story.

### Edit YAML

- validate on demand or live with debounce;
- show parse/schema errors with useful paths/context;
- mark the YAML buffer as having unapplied changes as soon as it differs from the validated Story representation;
- do not update preview/render state until valid YAML is applied;
- disable MP4 rendering while the YAML buffer has unapplied changes, whether those changes are valid or invalid, so rendering cannot silently export an older Story.

### Apply valid YAML

- replace the validated Story;
- update the visual editor;
- update preview;
- persist the new valid Story.

### Attempt to return to visual mode with invalid or unapplied YAML

Do not allow two divergent editor drafts to exist.

If the YAML buffer has unapplied changes and the user attempts to enter visual mode, intercept the transition and require one explicit choice:

- **Apply** — available only when the YAML parses and validates; commit it as the new validated Story, then enter visual mode;
- **Discard** — discard the YAML buffer and enter visual mode using the current validated Story;
- **Stay in YAML** — cancel the mode switch and preserve the buffer verbatim.

Until Apply or Discard is chosen:

- visual editing must not become active;
- the dirty YAML buffer remains the only editable draft;
- MP4 rendering remains disabled.

This avoids a retained YAML draft being based on an older Story while newer visual edits are made in parallel.

The retained dirty YAML buffer is editor-session state, not the persisted project in v0.2. A full page reload restores the last successfully persisted validated Story rather than persisting invalid/unapplied YAML.

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

### Persistence write failures

Every storage write must handle synchronous/browser storage failures such as quota exhaustion, denied storage, or unavailable storage.

If a validated Story is successfully applied/imported but persistence fails:

- keep the new validated Story active in memory;
- update the visual editor and preview normally;
- do not roll back the Story merely because autosave failed;
- show a persistent, actionable warning that local recovery is not guaranteed;
- offer YAML export as the manual backup path;
- retain the previously persisted valid Story, if any, rather than treating the failed write as successful.

Do not impose a new Story-schema size limit solely to satisfy localStorage.

On startup:

1. attempt to load stored data;
2. handle storage access errors without crashing;
3. validate any retrieved data with the current Story schema;
4. if valid, restore it;
5. if missing, invalid, corrupt, or storage is unavailable, fall back safely to the canonical/example Story and surface storage unavailability when relevant.

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
- reset restores the default Story;
- dirty/unapplied YAML blocks rendering, and apply/discard clears that block;
- attempting to leave dirty YAML for visual mode requires Apply, Discard, or Stay and never permits parallel visual edits;
- storage quota/access failures do not reject an otherwise valid Apply/import and leave the newly validated Story active in memory;
- a failed persistence write surfaces a warning and does not overwrite/claim success for the last persisted snapshot.

## Acceptance criteria

- visual and YAML modes operate on one validated Story;
- YAML can be imported and exported entirely in-browser;
- invalid YAML never reaches preview/render/persistence;
- any unapplied YAML buffer disables MP4 rendering until it is applied or explicitly discarded, preventing stale-video export;
- a dirty YAML buffer cannot coexist with subsequent visual edits: entering visual mode requires Apply, Discard, or Stay in YAML;
- valid YAML round-trips without semantic loss;
- when persistence succeeds, page reload restores the last persisted valid Story;
- localStorage quota/access failures are caught, do not undo a valid in-memory Story, and surface that reload recovery is not guaranteed;
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
