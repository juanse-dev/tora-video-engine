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

The visual editor may itself contain a temporary invalid draft that has not been committed to the validated Story. Do not generate YAML from the older validated Story while silently abandoning that draft.

If the visual candidate is schema-invalid when the user attempts to enter YAML mode, require one explicit choice:

- **Discard visual draft** — restore the visual editor from the current active Story, then generate canonical YAML and enter YAML mode;
- **Stay in visual editor** — cancel the transition and preserve the invalid visual draft.

If the visual candidate is schema-valid but browser-policy-ineligible, require one explicit choice:

- **Open candidate in YAML** — serialize that exact rejected candidate into the YAML buffer, transfer draft ownership to YAML, and enter YAML mode without changing the active Story;
- **Discard visual candidate** — restore from the active Story, then enter YAML mode;
- **Stay in visual editor** — cancel the transition.

If the visual editor has no pending candidate, entering YAML mode generates a canonical YAML representation from the current active Story.

Because dirty YAML cannot be left for visual mode without Apply or Discard, there should not be a retained dirty YAML buffer while the visual editor is active. The two modes must never own divergent drafts concurrently.

Exact whitespace/comments from an originally imported file do not need to be preserved after the YAML has been successfully applied and later regenerated from the validated Story.

### Edit YAML

Track YAML dirty state relative to a **YAML baseline buffer**, not by comparing text to canonical serialization of the active Story.

- when YAML mode opens from the active Story, generate canonical YAML and set that exact text as both buffer and clean baseline;
- when a visual candidate is explicitly transferred to YAML, set the transferred serialization as the buffer; it remains dirty relative to the active Story because it has not been applied;
- after a successful Apply, set the **current exact YAML buffer** as the new clean baseline without rewriting whitespace/comments/quotes/key order;
- subsequent edits are dirty only when they differ from that baseline;
- leaving and later re-entering YAML after a clean Apply may regenerate canonical YAML from the active Story, consistent with v0.2 not promising formatting/comment preservation across mode changes;
- validate on demand or live with debounce;
- show source-size/parse/schema/browser-policy errors distinctly;
- do not update preview/render state until eligible YAML is applied;
- disable MP4 rendering while the YAML buffer is dirty, whether its content is invalid, schema-valid, or browser-policy-ineligible.

This ensures noncanonical but successfully applied YAML becomes clean immediately instead of being marked dirty again merely because canonical serialization would look different.

### Browser YAML source-size guard

Do not synchronously parse arbitrarily large YAML on the UI thread.

For v0.2, define a browser-only maximum YAML source size of **1 MiB (1,048,576 UTF-8 bytes)**.

Apply the guard **before** calling `parseStorySource()`:

- for file import, inspect `File.size` before reading/parsing the file;
- for pasted/edited YAML, measure the current buffer as UTF-8 bytes (for example with `TextEncoder`) before parsing;
- if the source exceeds 1 MiB, do not invoke YAML parsing or Zod validation;
- keep the existing active Story untouched;
- show a browser source-size warning and offer the CLI path;
- this limit is a browser safety policy, not a change to the shared Story/YAML contract or local CLI.

### Apply valid YAML

Source-size, schema validation, and browser authoring eligibility are separate checks.

After the source passes the 1 MiB guard, YAML parses, and passes `StorySchema`:

1. evaluate the WEB-003 browser authoring/preview budget using the shared centralized policy;
2. if the candidate is within **200 scenes** and **9,000 derived frames**, replace the active validated Story, update the visual editor/preview, set the current YAML buffer as the new clean baseline, and attempt persistence;
3. if the candidate exceeds either browser limit, do **not** replace the active validated Story, do **not** mount it into the visual editor/Player, and do **not** persist it as the active browser project.

For an over-budget but schema-valid candidate:

- keep the YAML buffer intact;
- show that the document is valid for the engine/CLI but too large for v0.2 browser authoring;
- keep MP4 browser rendering disabled;
- offer Discard/Stay and the CLI/YAML portability path rather than presenting a schema error.

### Attempt to return to visual mode with invalid or unapplied YAML

Do not allow two divergent editor drafts to exist.

If the YAML buffer has unapplied changes and the user attempts to enter visual mode, intercept the transition and require one explicit choice:

- **Apply** — available only when the YAML parses, passes StorySchema, **and passes the centralized browser authoring/preview policy**; commit it as the new active Story, then enter visual mode;
- **Discard** — discard the YAML buffer and enter visual mode using the current validated Story;
- **Stay in YAML** — cancel the mode switch and preserve the buffer verbatim.

For schema-valid but browser-policy-ineligible YAML, **Apply is disabled**. The available choices are Discard or Stay in YAML; the UI must explain that the document is valid for CLI/engine use but cannot become the active browser Story.

Until an eligible Apply or Discard is chosen:

- visual editing must not become active;
- the dirty YAML buffer remains the only editable draft;
- MP4 rendering remains disabled.

This avoids a retained YAML draft being based on an older Story while newer visual edits are made in parallel.

The retained dirty YAML buffer is editor-session state, not the persisted project in v0.2. A full page reload restores the last successfully persisted validated Story rather than persisting invalid/unapplied YAML.

## Import

Support a browser file input for \`.yaml\` / \`.yml\`.

Imported text must use the same source-size guard, parser, schema, and browser authoring policy as pasted/edited YAML.

For files, reject `File.size > 1 MiB` before `File.text()` / parsing. No separate import schema is allowed. After schema validation, import must also pass the same browser authoring/preview policy used by Apply before it can become the active Story.

## Export

Provide two unambiguous export paths so the user never downloads the older active Story when intending to take a pending candidate to the CLI.

### Export active Story

Serialize the active validated Story to deterministic, human-readable canonical YAML and download it with a stable filename derived from the active Story title or a documented fallback.

### Export current YAML candidate

When the current YAML buffer is within the 1 MiB source limit and parses/passes `StorySchema`, allow downloading that **exact buffer** even if it fails the browser authoring/preview budget and therefore cannot be Applied.

This action:

- is available for schema-valid policy-ineligible YAML, including a visual over-budget candidate transferred into YAML;
- preserves the user's current YAML formatting/comments because it downloads the buffer verbatim;
- does not make the candidate active, mount it in Player, persist it, or enable MP4 browser render;
- is disabled for source-oversized, parse-invalid, or schema-invalid YAML;
- uses the parsed candidate title for the filename when available, with a documented fallback.

Label the actions so it is clear whether the download represents the **active Story** or the **current YAML candidate**.

Serialization/export must not change Story semantics.

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
4. if schema-valid, run the same centralized browser authoring/preview policy used by visual editing, YAML Apply, and import **before** making it active or mounting the Player;
5. if both checks pass, restore it as the active Story;
6. if the stored payload is schema-valid but over browser budget, do not mount it; fall back to the canonical/example Story and show a browser-limit warning explaining that the stored document is not schema-invalid;
7. if missing, schema-invalid, corrupt, or storage is unavailable, fall back safely to the canonical/example Story and surface the appropriate validation/storage warning.

## Reset

Provide a clear way to reset the local project to the canonical/default Story.

## Tests

Cover:

- Story → YAML → Story semantic round-trip;
- applying schema-valid noncanonical YAML establishes the exact applied buffer as clean baseline and does not immediately re-dirty it;
- editing after Apply dirties relative to the applied baseline;
- invalid YAML does not replace validated Story;
- a >1 MiB file is rejected before file text parsing;
- a >1 MiB pasted/edited buffer is rejected before `parseStorySource()`;
- imported schema-valid, browser-eligible YAML updates the Story;
- imported schema-valid YAML with 201+ scenes is retained/reported as over-budget without replacing or mounting the active Story;
- imported schema-valid YAML above 9,000 derived frames is retained/reported as over-budget without replacing or mounting the active Story;
- schema-valid browser-policy-ineligible YAML can be exported verbatim as the current candidate for CLI use without exporting the older active Story;
- corrupt localStorage falls back safely;
- schema-valid, browser-eligible localStorage restores;
- schema-invalid stored data is rejected;
- schema-valid but browser-over-budget stored data is rejected before Player mount, falls back safely, and shows a policy warning;
- reset restores the default Story;
- dirty/unapplied YAML blocks rendering, and apply/discard clears that block;
- attempting to leave dirty YAML for visual mode requires Apply, Discard, or Stay and never permits parallel visual edits;
- attempting to leave a schema-invalid visual draft for YAML requires Discard or Stay and never silently regenerates from the older active Story;
- attempting to leave a browser-policy-rejected visual candidate for YAML requires explicit transfer to YAML, Discard, or Stay;
- storage quota/access failures do not reject an otherwise valid Apply/import and leave the newly validated Story active in memory;
- a failed persistence write surfaces a warning and does not overwrite/claim success for the last persisted snapshot.

## Acceptance criteria

- visual and YAML modes operate on one validated Story;
- YAML can be imported and exported entirely in-browser;
- browser YAML parsing is never attempted for source text above 1 MiB UTF-8;
- invalid YAML never reaches preview/render/persistence;
- dirty state is relative to the YAML baseline buffer, and a successful Apply makes the exact applied buffer clean even when it is noncanonical;
- any dirty/unapplied YAML buffer disables MP4 rendering until it is applied or explicitly discarded, preventing stale-video export;
- Apply is enabled only when YAML is both schema-valid and browser-authoring-eligible;
- a dirty YAML buffer cannot coexist with subsequent visual edits: entering visual mode requires Apply, Discard, or Stay in YAML;
- a schema-invalid visual draft cannot be silently replaced when entering YAML: the user must Discard it or Stay in visual mode;
- a browser-policy-rejected visual candidate can only leave visual mode through explicit candidate→YAML transfer, Discard, or Stay;
- browser-eligible valid YAML round-trips without semantic loss;
- schema-valid but browser-over-budget YAML remains distinguishable from schema-invalid YAML, never reaches the live Player/persistence as the active Story, and can still be exported verbatim as a CLI candidate;
- when persistence succeeds, page reload restores the last persisted Story only if it still passes both StorySchema and current browser authoring policy;
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
