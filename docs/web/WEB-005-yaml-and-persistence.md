# WEB-005 — YAML workflow and local persistence

> Status: **Proposed**

## Goal

Preserve YAML as a first-class external format while making the web editor local-first and safe against invalid text.

## User-visible outcome

A user can:

- switch between visual authoring and YAML;
- import an existing Story YAML file;
- validate YAML with useful errors;
- apply browser-eligible valid YAML to the visual editor and preview;
- export the active Story as canonical YAML;
- export a schema-valid current YAML candidate verbatim for CLI use even when browser-policy-ineligible;
- reload the page and recover the last browser-eligible persisted project.

## YAML editing model

Do not make raw YAML text the live render source while the user is typing.

Use a draft buffer:

~~~text
YAML text buffer
      ↓
≤ 1 MiB UTF-8?
  │          └── no → source-size warning; do not parse
 yes
  ↓
parseStorySource()
      ↓
schema-valid? ── no → show errors; keep active Story
  │
 yes
  ↓
browser authoring policy
  │          └── ineligible → keep YAML candidate; disable Apply/render
 eligible
  ↓
Apply
  ↓
Active Validated Story
~~~

An explicit “Apply YAML” action is preferred for v0.2 because it avoids replacing a user's text/cursor position while still preserving one authoritative Story for preview/render.

## Visual ↔ YAML behavior

### Enter YAML mode

The visual editor may itself contain a temporary invalid draft that has not been committed to the validated Story. Do not generate YAML from the older validated Story while silently abandoning that draft.

If the visual candidate is schema-invalid when the user attempts to enter YAML mode, require one explicit choice:

- **Discard visual draft** — restore the visual editor from the current active Story, then generate canonical YAML and enter YAML mode;
- **Stay in visual editor** — cancel the transition and preserve the invalid visual draft.

If the visual candidate is schema-valid but browser-policy-ineligible, require one explicit choice:

- **Open candidate in YAML** — serialize that exact rejected candidate into the YAML buffer, transfer draft ownership to YAML, and enter YAML mode without changing the active Story. Retain a **validated transfer snapshot** containing the schema-validated Story plus the exact serialized buffer produced during transfer;
- **Discard visual candidate** — restore from the active Story, then enter YAML mode;
- **Stay in visual editor** — cancel the transition.

The validated transfer snapshot is provenance, not a second active Story. It exists only to prove that the unchanged transferred YAML buffer came from a Story that already passed `StorySchema` before the browser-policy rejection.

If the visual editor has no pending candidate, entering YAML mode generates a canonical YAML representation from the current active Story.

Because dirty YAML cannot be left for visual mode without Apply or Discard, there should not be a retained dirty YAML buffer while the visual editor is active. The two modes must never own divergent drafts concurrently.

Exact whitespace/comments from an originally imported file do not need to be preserved after the YAML has been successfully applied and later regenerated from the validated Story.

### Edit YAML

Track YAML dirty state relative to a **YAML baseline buffer**, not by comparing text to canonical serialization of the active Story.

- when YAML mode opens from the active Story, generate canonical YAML and set that exact text as both buffer and clean baseline;
- when a browser-policy-rejected visual candidate is explicitly transferred to YAML, **regenerate the clean baseline from the current active Story at transfer time** using `serializeStorySource(activeStory)`, then replace only the buffer with the transferred candidate serialization so the candidate is immediately dirty/unapplied; attach the validated transfer snapshot to that exact buffer; never reuse a baseline retained from an earlier YAML session;
- any edit that changes the transferred YAML buffer immediately clears the validated transfer snapshot, because the edited text is no longer known to represent the previously validated Story;
- after a successful Apply, set the **current exact YAML buffer** as the new clean baseline without rewriting whitespace/comments/quotes/key order and clear any transfer snapshot because the Story is now active;
- subsequent edits are dirty only when they differ from that baseline;
- once YAML mode is left cleanly, its baseline is session-local and must not be treated as authoritative after later visual commits; the next YAML entry or visual→YAML transfer establishes a fresh baseline from the then-current active Story;
- validate on demand or live with debounce;
- show source-size/parse/schema/browser-policy errors distinctly;
- do not update preview/render state until eligible YAML is applied;
- disable MP4 rendering while the YAML buffer is dirty, whether its content is invalid, schema-valid, or browser-policy-ineligible.

This ensures noncanonical but successfully applied YAML becomes clean immediately instead of being marked dirty again merely because canonical serialization would look different.

### Browser YAML source-size guard

Do not synchronously parse arbitrarily large YAML on the UI thread.

For v0.2, define a browser-only maximum YAML source size of **1 MiB (1,048,576 UTF-8 bytes)**.

Apply the guard **before** calling `parseStorySource()` on raw/untrusted YAML:

- for file import, inspect `File.size` before reading/parsing the file;
- for pasted/edited YAML, measure the current buffer as UTF-8 bytes (for example with `TextEncoder`) before parsing;
- if the source exceeds 1 MiB, do not invoke YAML parsing or Zod validation;
- keep the existing active Story untouched;
- show a browser source-size warning and offer the CLI path;
- this limit is a browser safety policy, not a change to the shared Story/YAML contract or local CLI.

The guard prevents parsing oversized text; it does **not** prohibit downloading bytes. The one exception to "oversized YAML cannot be treated as schema-valid in the editor" is an unchanged buffer with a validated transfer snapshot from the visual editor: its schema validity was established before serialization, so no parse is needed merely to export that exact candidate.

### Apply valid YAML

Source-size, schema validation, and browser authoring eligibility are separate checks. Browser authoring eligibility includes the candidate title and canonical `serializeStorySource()` size, even when the incoming YAML buffer itself is under 1 MiB.

After the source passes the 1 MiB guard, YAML parses, and passes `StorySchema`:

1. run the same centralized policy used by WEB-003 for every candidate source;
2. first require `candidate.title.length <= 65_536`; if it fails, stop **before** timeline derivation or canonical serialization and report a browser-policy title error, not a schema error;
3. derive/check scene count and total frames;
4. canonicalize the parsed candidate with WEB-001 `serializeStorySource()` and require its UTF-8 size to be ≤ **1 MiB**;
5. if the candidate satisfies the title bound, **200 scenes**, **9,000 derived frames**, and **1 MiB canonical YAML**, replace the active validated Story, update the visual editor/preview, set the current YAML buffer as the new clean baseline, and attempt persistence;
6. if the candidate exceeds any browser limit, do **not** replace the active validated Story, do **not** mount it into the visual editor/Player, and do **not** persist it as the active browser project.

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

The retained dirty YAML buffer is editor-session state, not the persisted project in v0.2. A reload still restores the last successfully persisted validated Story, but the browser must warn before a reload/navigation/tab close would discard dirty YAML.

### Unload protection for session-only work

Install a `beforeunload` handler while any state exists that would be lost by leaving the page:

- YAML buffer is dirty/unapplied;
- a pending visual draft differs from the active Story;
- a validated transfer snapshot/current transferred candidate exists;
- the active in-memory Story differs from durable storage for any reason, including a failed persistence attempt **or persistence intentionally suppressed while a rejected stored recovery snapshot protects the storage slot**.

The handler must use the standard browser-native confirmation mechanism (`event.preventDefault()` plus the compatibility `event.returnValue` assignment where required). Do not depend on custom dialog text because modern browsers control the warning wording.

Remove the listener immediately when none of those loss-risk conditions remain, such as after successful Apply + persistence, explicit Discard/Reset, or successful persistence of the active Story. Merely suppressing a write because the recovery slot is protected does **not** make the active Story durable and must not clear unload protection.

A rejected stored recovery snapshot does not by itself require `beforeunload` because its durable storage slot is protected; its protection is governed by the recovery rules below.

If client-side routing is added later, route transitions must honor the same loss-risk predicate rather than relying only on `beforeunload`.

## Import

Support a browser file input for `.yaml` / `.yml`.

Imported text must use the same source-size guard, parser, schema, and browser authoring policy as pasted/edited YAML.

For files, reject `File.size > 1 MiB` before `File.text()` / parsing. No separate import schema is allowed. After schema validation, import must also pass the same browser authoring/preview policy used by Apply before it can become the active Story.

### Import is a transactional destructive transition

An import candidate may be size-checked, parsed, schema-validated, and browser-policy-checked in isolation, but those steps must not mutate the active Story, editor draft ownership, YAML baseline, transfer provenance, recovery protection, or persistence.

Only after the imported candidate is fully schema-valid and browser-eligible may the app attempt to commit it.

Before commit, evaluate the same loss-risk predicate used by unload protection plus protected recovery state. If any of the following exists:

- dirty/unapplied YAML;
- a pending visual draft;
- a validated transfer snapshot/current transferred candidate;
- an active Story that differs from durable storage because persistence failed or was intentionally suppressed;
- a rejected stored recovery snapshot whose protected slot would need to be released before the import can persist;

require an explicit choice:

- **Discard current pending/recovery work and import** — clearly identify which current state will be lost; after confirmation, atomically clear the identified draft/transfer state, explicitly release protected recovery storage when applicable, commit the already validated imported Story, and attempt best-effort persistence;
- **Cancel import** — discard only the temporary import candidate and leave all pre-import state unchanged.

If the current pending/recovery state is exportable, keep its export action available before the destructive confirmation.

An invalid or browser-policy-ineligible import candidate must never trigger the destructive confirmation or alter current work; report the import error and discard only the temporary import candidate.

The temporary import candidate is non-editable transaction state, not a second authoring draft. The app must never expose it concurrently as an independently editable project.

## Export

Provide two unambiguous export paths so the user never downloads the older active Story when intending to take a pending candidate to the CLI.

### Export active Story

Serialize the active validated Story with WEB-001 `serializeStorySource()` and download it with a stable filename derived from the active Story title or a documented fallback.

Because canonical YAML size ≤1 MiB is part of browser authoring eligibility, this export is guaranteed to remain within the browser import source-size guard and must be re-importable by the same web app.

### Export current YAML candidate

Allow downloading the **exact current buffer** through either of two evidence paths:

1. **Parsed candidate** — the buffer is ≤1 MiB, has been parsed, and passes `StorySchema`; or
2. **Validated transferred candidate** — the buffer exactly matches the unchanged validated transfer snapshot created by **Open candidate in YAML**. This path may exceed 1 MiB because it does not call `parseStorySource()`; schema validity came from the visual candidate before serialization.

This action:

- is available for schema-valid policy-ineligible YAML, including a visual candidate rejected because its canonical YAML exceeds 1 MiB;
- preserves the user's current YAML bytes/text exactly as represented by the buffer;
- does not make the candidate active, mount it in Player, persist it, or enable MP4 browser render;
- clears the validated-transfer evidence immediately if the user edits the buffer; an edited >1 MiB buffer is therefore not exportable as a validated candidate until it is reduced below the source guard and successfully parsed;
- remains disabled for parse-invalid/schema-invalid YAML, and for oversized raw/edited YAML that has no matching validated transfer snapshot;
- uses the validated transferred Story title or parsed candidate title for the filename when available, with a documented fallback.

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
4. if schema-valid, run the same centralized browser authoring/preview policy used by visual editing, YAML Apply, and import **before** making it active or mounting the Player; this starts with `storedStory.title.length <= 65_536` before timeline derivation/canonical serialization;
5. if both checks pass, restore it as the active Story;
6. if the stored payload is schema-valid but browser-policy-ineligible, do not mount it. Retain the validated payload in memory as a **rejected stored recovery snapshot**, activate the canonical/example Story only as an in-memory fallback, and show a persistent recovery banner;
7. while a rejected stored recovery snapshot exists, do **not** automatically persist the fallback Story or later fallback-based edits into the same storage slot, because that would destroy the only stored copy;
8. any valid fallback edit committed while that slot is protected immediately makes the active Story **unpersisted loss-risk state**: show the persistence/recovery warning, enable `beforeunload`, and offer **Export active Story YAML** as backup even though no storage write was attempted;
9. provide **Export stored project YAML** using the already validated recovery snapshot (serialization may exceed the browser import guard because this is a CLI recovery path) and **Discard stored project and continue** as an explicit destructive action;
10. exporting the recovery snapshot alone must not delete/overwrite it; only explicit discard/reset/import acknowledgement may release the protected storage slot;
11. after the user explicitly releases the recovery snapshot, if the current active Story differs from durable storage, immediately attempt to persist that active Story; unload protection remains until that persistence succeeds or the in-memory change is explicitly discarded/reset;
12. if missing, schema-invalid, corrupt, or storage is unavailable, fall back safely to the canonical/example Story and surface the appropriate validation/storage warning.

## Reset

Provide a clear way to reset the local project to the canonical/default Story, but treat reset as a destructive state transition.

If there is no pending visual/YAML draft and no rejected stored recovery snapshot, reset may proceed directly.

If YAML is dirty, a visual candidate is pending, a validated transfer snapshot exists, or a rejected stored recovery snapshot is protected, intercept Reset and require an explicit choice:

- **Discard pending/recovery state and reset** — clearly state what will be lost, then atomically clear editor drafts/transfer provenance/recovery protection, activate the canonical Story, and attempt best-effort persistence;
- **Stay** — cancel Reset and preserve all current state.

Do not auto-Apply a dirty YAML draft merely to perform Reset. When a schema-valid candidate/recovery snapshot can be exported, keep its export action available before destructive confirmation.

A confirmed reset that fails to persist still changes the active in-memory Story to the canonical default and surfaces the normal persistence warning; it must not falsely claim that durable reset succeeded.

## Tests

Cover:

- Story → YAML → Story semantic round-trip;
- applying schema-valid noncanonical YAML establishes the exact applied buffer as clean baseline and does not immediately re-dirty it;
- editing after Apply dirties relative to the applied baseline;
- invalid YAML does not replace validated Story;
- a >1 MiB file is rejected before file text parsing;
- a >1 MiB pasted/edited buffer is rejected before `parseStorySource()`;
- imported schema-valid YAML with a 65,537-code-unit title is rejected by browser policy before timeline/canonical serialization even though the YAML source itself is ≤1 MiB;
- an invalid/import-policy-ineligible file never discards an existing dirty YAML or pending visual draft;
- an eligible import with dirty YAML/pending visual/transfer/unpersisted/recovery state requires explicit destructive confirmation before commit;
- cancelling that confirmation preserves the pre-import state byte-for-byte/logically unchanged;
- imported schema-valid, browser-eligible YAML updates the Story after the destructive-transition guard passes;
- imported schema-valid YAML with 201+ scenes is retained/reported as over-budget without replacing or mounting the active Story;
- imported schema-valid YAML above 9,000 derived frames is retained/reported as over-budget without replacing or mounting the active Story;
- schema-valid browser-policy-ineligible YAML can be exported verbatim as the current candidate for CLI use without exporting the older active Story;
- a visual candidate rejected because canonical YAML exceeds 1 MiB can be transferred and exported without reparsing while the buffer remains unchanged;
- editing that oversized transferred buffer invalidates its transfer snapshot and disables validated-candidate export until it is ≤1 MiB and parses successfully;
- corrupt localStorage falls back safely;
- schema-valid but browser-policy-rejected storage is retained as a recovery snapshot, is exportable for CLI use, and is not overwritten by fallback autosave;
- exporting a rejected stored recovery snapshot does not clear it; explicit discard/reset acknowledgement is required before its storage slot can be replaced;
- schema-valid, browser-eligible localStorage restores, including a recheck that canonical YAML is ≤1 MiB;
- schema-invalid stored data is rejected;
- schema-valid but browser-over-budget stored data is rejected before Player mount, falls back safely, and shows a policy warning;
- reset restores the default Story when no draft is pending;
- Reset with dirty YAML/pending visual state requires explicit destructive confirmation and never silently discards the draft;
- Reset with a rejected stored recovery snapshot requires explicit discard acknowledgement before protected storage can be replaced;
- dirty/unapplied YAML blocks rendering, and apply/discard clears that block;
- dirty YAML installs unload protection; applying/discarding it removes the guard once no other loss-risk state remains;
- a persistence write failure on a newly active Story keeps unload protection enabled until that Story is durably saved or explicitly discarded/reset;
- editing the fallback while a rejected recovery snapshot protects the storage slot also enables unload protection even though no write is attempted;
- releasing the recovery slot triggers persistence of the current active Story when it differs from durable storage, and unload protection remains until that succeeds;
- attempting to leave dirty YAML for visual mode requires Apply, Discard, or Stay and never permits parallel visual edits;
- attempting to leave a schema-invalid visual draft for YAML requires Discard or Stay and never silently regenerates from the older active Story;
- attempting to leave a browser-policy-rejected visual candidate for YAML requires explicit transfer to YAML, Discard, or Stay;
- transferring a candidate always regenerates the YAML clean baseline from the **current** active Story, so an older YAML session cannot become a stale-clean baseline;
- storage quota/access failures do not reject an otherwise valid Apply/import and leave the newly validated Story active in memory;
- a failed persistence write surfaces a warning and does not overwrite/claim success for the last persisted snapshot.

## Acceptance criteria

- visual and YAML modes operate on one validated Story;
- YAML can be imported and exported entirely in-browser;
- an eligible import cannot replace dirty/pending/unpersisted/recovery state without explicit destructive confirmation, while invalid imports leave existing work untouched;
- browser YAML parsing is never attempted for raw/edited source text above 1 MiB UTF-8; unchanged oversized text originating from a validated visual transfer may be exported without parsing;
- invalid YAML never reaches preview/render/persistence;
- dirty state is relative to the YAML baseline buffer, and a successful Apply makes the exact applied buffer clean even when it is noncanonical;
- any dirty/unapplied YAML buffer disables MP4 rendering until it is applied or explicitly discarded, preventing stale-video export;
- Apply is enabled only when YAML is both schema-valid and browser-authoring-eligible, including the centralized 65,536-code-unit title bound;
- a dirty YAML buffer cannot coexist with subsequent visual edits: entering visual mode requires Apply, Discard, or Stay in YAML;
- a schema-invalid visual draft cannot be silently replaced when entering YAML: the user must Discard it or Stay in visual mode;
- a browser-policy-rejected visual candidate can only leave visual mode through explicit candidate→YAML transfer, Discard, or Stay;
- browser-eligible valid YAML round-trips without semantic loss;
- every active Story's canonical YAML export is ≤1 MiB and can be re-imported by the same browser workflow;
- schema-valid but browser-over-budget YAML remains distinguishable from schema-invalid YAML, never reaches the live Player/persistence as the active Story, and can still be exported verbatim as a CLI candidate; this includes unchanged >1 MiB buffers carrying validated visual-transfer provenance;
- when persistence succeeds, page reload restores the last persisted Story only if it still passes StorySchema and all current browser authoring checks, including title ≤65,536 and canonical YAML ≤1 MiB; a schema-valid policy-rejected stored Story remains protected/exportable until explicit discard rather than being overwritten by fallback persistence;
- localStorage quota/access failures are caught, do not undo a valid in-memory Story, surface that reload recovery is not guaranteed, and keep unload protection active while the in-memory Story is not durably stored;
- intentionally suppressed persistence while protecting a rejected recovery snapshot is treated identically as loss-risk for unload purposes;
- reload/navigation/tab close raises a native confirmation whenever dirty/pending/unpersisted session state would otherwise be lost;
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
