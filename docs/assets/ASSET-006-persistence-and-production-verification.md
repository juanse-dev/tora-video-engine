# ASSET-006 — Persistence and production verification

> Status: **Proposed**

## Goal

Close v0.3 by proving that local custom assets coexist safely with the ASSET-001 project-persistence v2 boundary, survive normal same-origin browser reload/deploy cycles, fail explicitly when unavailable, and render consistently in browser and CLI.

## Compatibility principle

v0.3 must be additive.

Existing v0.2 **Story/YAML content** containing only bundled refs must:

- parse unchanged;
- serialize with identical Story semantics;
- preview unchanged;
- render unchanged in browser;
- render unchanged in CLI.

Browser durable project state does have an explicit compatibility migration defined in ASSET-001:

~~~text
persistence envelope v1
        ↓
deterministic migration
        ↓
persistence envelope v2
~~~

The migrated bundled Story content remains semantically identical. ASSET-006 verifies that migration and cross-version safety; it does not redefine them.

An old v0.2 tab must see a v2 envelope as unsupported-version/recovery, while the existing unversioned persistence Web Lock continues to protect the shared physical Story/recovery slots.

## Persistence separation

Keep these stores conceptually separate:

~~~text
Story project state
  → existing localStorage envelope

Local custom asset library
  → IndexedDB asset database

Browser render scratch
  → Remotion OPFS namespace
~~~

Do not merge them into one large persistence object.

Benefits:

- Story export remains small;
- asset bytes are not duplicated across Stories;
- clearing one Story does not necessarily delete the reusable asset library;
- Remotion cleanup cannot delete user assets;
- local asset loss is represented as missing references rather than malformed Story data.

## Reset semantics

The existing **Reset project** action resets Story/project authoring state.

It must **not** silently delete the My assets library.

Local library deletion is explicit through asset-management actions.

If a future “Clear local asset library” action is added, it is a separate destructive operation with its own confirmation and usage warning.

## Browser startup

Startup order after ASSET-002:

1. restore/validate/migrate the Story envelope using the ASSET-001 v1 → v2 compatibility boundary and existing recovery safeguards;
2. open the local asset database independently;
3. resolve local refs used by the restored/fallback Active Story;
4. derive asset readiness;
5. mount preview with resolved images or explicit missing placeholders.

Failure to open the asset DB must not corrupt/discard the Story.

If the Story references local assets but the library cannot be read:

- preserve Story;
- show asset-library warning;
- treat those refs as unavailable;
- keep YAML export available;
- block MP4 rendering.

Bundled-only Stories should remain usable even if IndexedDB is unavailable.

## New deployment behavior

The Netlify production origin remains:

~~~text
https://tora-video-engine.netlify.app
~~~

A normal same-origin application deploy must not intentionally clear the browser asset DB.

Because browser storage is origin-scoped, local assets are expected to remain available across Tora code deployments on the same production origin, unless:

- browser/site data is cleared;
- quota eviction occurs;
- the database is intentionally migrated/cleared;
- the user changes browser/profile/device/origin.

This persistence is best-effort browser storage, not sync or backup.

Production, Deploy Previews, and localhost are intentionally different asset-library origins. A library created at `deploy-preview-N--tora-video-engine.netlify.app` is not expected to appear at `tora-video-engine.netlify.app`, and localhost does not share either library.

## Asset database versioning

The asset database has its own schema version independent from the Story persistence version.

Migration requirements:

- opening an older supported DB version performs bounded deterministic migration;
- failed migration does not rewrite Story data;
- unsupported/corrupt asset metadata degrades affected refs to missing;
- never reinterpret unknown binary records as trusted images;
- a DB migration must not change content hashes for unchanged original bytes.

For initial v0.3 there is only version 1, but tests should establish the version boundary.

## Durable Story with deleted asset

Deleting a local asset does not rewrite persisted Story refs.

After reload:

~~~text
Story restores successfully
+
asset ref is absent
=
same Story + explicit missing asset state
~~~

This is intentional.

The user can:

- re-import the exact file and recover automatically;
- choose a replacement;
- edit YAML;
- export YAML.

## Exact-file recovery

The main portability/recovery invariant is:

~~~text
same original bytes
+ same category
→ same SHA-256/category ref
→ Story resolves without mutation
~~~

Test this after:

- deleting an asset;
- clearing/recreating the asset DB;
- moving YAML into a fresh browser context;
- using the same fixture in the CLI local asset folder.

## Browser policy interaction

Asset readiness is evaluated **after** Story schema/browser authoring policy.

A Story can be:

~~~text
schema-valid
browser-policy eligible
asset-unready
~~~

That state:

- may persist;
- may export;
- may be visually edited;
- cannot render MP4.

Do not add local-asset byte sizes to the existing canonical-YAML 1 MiB policy because the bytes are not part of YAML.

The local-image resource limits (≤25 MiB source bytes, ≤8192 px per side, ≤50 MP, static PNG/JPEG/WebP only) apply per imported/source asset, not to Story source size.

## Loss-risk semantics

Importing/deleting/renaming local library entries is durable library state, not a pending Story draft.

However:

- applying a local asset to a scene changes the Story and follows normal Story loss-risk/autosave rules;
- deleting an in-use asset leaves Story refs unchanged and therefore does not count as silently discarding Story work;
- if the local library write itself fails, the operation reports failure and prior library state remains authoritative.

No browser unload warning is required solely because a completed IndexedDB asset mutation has already committed durably.

## Production verification fixture

Add small source-controlled **test fixtures** for v0.3 verification; do not use a developer's personal `local-assets/` contents.

At minimum include:

- one custom pose fixture;
- one custom background fixture.

Fixtures should be modest in size and clearly test-only.

Automated tests derive their expected SHA-256 refs from these fixed bytes.

## Browser automated golden

Add a production-build Playwright flow that:

1. starts with a clean asset DB;
2. loads the canonical bundled Story;
3. imports the custom pose fixture;
4. imports the custom background fixture;
5. applies both to scenes;
6. verifies the Story contains stable local refs and no bytes/blob URLs;
7. reloads;
8. verifies the library and selected refs still resolve;
9. renders browser MP4;
10. verifies H.264/video-only/1080×1920/30 FPS/expected frame count;
11. samples frames and confirms custom images are actually present;
12. exports YAML and confirms only content-addressed refs are included.

Use the existing browser-render golden infrastructure where possible.

## Missing/deletion browser flow

Automate:

1. import/apply local asset;
2. attempt delete while used;
3. verify warning identifies affected scene count;
4. cancel and verify nothing changes;
5. delete with confirmation;
6. verify Story ref remains exact;
7. verify explicit missing state;
8. verify Render MP4 disabled;
9. reload and verify missing state persists;
10. re-import exact fixture in the same category;
11. verify Story resolves automatically with no Story mutation;
12. verify render eligibility returns.

## Fresh-browser portability flow

Using a fresh browser context/origin storage:

1. import/export YAML from context A;
2. load YAML in context B without asset library;
3. verify Story parses and missing ref is explicit;
4. import the exact file in B using the same category;
5. verify hash/category ref resolves automatically;
6. verify preview/render eligibility recovers.

No bytes are transferred through YAML.

## CLI parity golden

Use the same source-controlled fixture bytes in a temporary local-asset root.

Automate:

1. load the same custom-ref Story used by browser tests;
2. index temp `poses/` and `backgrounds/`;
3. verify refs resolve to the same SHA-256 values;
4. render through CLI;
5. verify output metadata;
6. sample frames to prove custom pose/background are present.

This test must not depend on a developer's real gitignored `local-assets/` folder.

## Browser storage failure tests

Cover at least:

- IndexedDB unavailable/open failure;
- write transaction failure/quota-like error;
- metadata row present but Blob missing/corrupt;
- Blob row present without metadata;
- database cleared while Story persists.

Expected behavior is bounded, explicit degradation rather than Story deletion.

## Cross-tab verification

Verify two same-origin tabs converge on local-library state:

- import in tab A appears in/refetches into tab B;
- rename in A updates label in B without Story ref changes;
- delete in A makes a referenced asset missing in B on refresh/invalidation;
- concurrent duplicate imports do not create duplicate binary storage;
- while tab A renders, its local asset mutation controls remain disabled;
- a cross-tab deletion during A's in-flight render does not alter A's frozen Story/runtime-source snapshot, but becomes missing on A's post-render readiness refresh.

Existing Story single-writer rules remain unchanged and separate.

## Netlify production manual verification

Before marking v0.3 complete, verify on the production origin:

1. app opens with existing bundled Story after verifying any persisted v1 project migrates safely to v2;
2. import one custom pose and one custom background;
3. both appear under **My assets**, separate from Bundled;
4. apply them and verify Player;
5. reload and verify they remain available;
6. export YAML and inspect that refs are present but bytes/blob URLs are absent;
7. render/download MP4 successfully;
8. delete one in-use asset and confirm warning + missing state;
9. re-import exact file in the same category and confirm automatic resolution;
10. render again successfully;
11. confirm no custom asset was uploaded to Netlify/server infrastructure.

Record:

- production commit;
- production URL;
- browser/version;
- custom fixture refs;
- browser golden result;
- CLI parity result.

## v0.3 completion checklist

- [ ] ASSET-001 accepted
- [ ] ASSET-002 accepted
- [ ] ASSET-003 accepted
- [ ] ASSET-004 accepted
- [ ] ASSET-005 accepted
- [ ] existing bundled YAML/Story content remains unchanged while persisted v1 projects migrate safely to v2
- [ ] browser local library persists across reload on same origin
- [ ] bundled and My assets are separate in UI
- [ ] static PNG/JPEG/WebP imports reject APNG/animated WebP and enforce 25 MiB pre-read, ≤8192 px/side, and ≤50 MP limits
- [ ] SHA-256 dedup works
- [ ] labels rename without changing refs
- [ ] YAML contains refs only, no bytes/blob URLs/paths
- [ ] delete-in-use warning passes
- [ ] missing refs preserve Story and block render
- [ ] exact-file same-category re-import resolves missing ref automatically
- [ ] ASSET-001 pinned-Remotion runtime-source transport gate is accepted before storage/UI rollout
- [ ] custom pose/background Player flow passes
- [ ] custom pose/background browser MP4 golden passes
- [ ] fresh-browser YAML portability flow passes
- [ ] CLI resolves same refs from local asset folders
- [ ] required local asset helper prints full canonical copy/pasteable refs
- [ ] CLI missing-asset diagnostics pass
- [ ] CLI/browser custom-asset parity golden passes
- [ ] cross-tab library convergence and frozen-render snapshot behavior pass
- [ ] production remains static-hosted/backend-free
- [ ] production custom-asset golden passes

## Acceptance criteria

- v0.2 bundled Story/render behavior remains stable and persistence v1 → v2 migration is verified;
- v0.3 local assets survive ordinary same-origin reload/deploy use;
- loss of local bytes never corrupts or silently changes Story meaning;
- browser and CLI resolve the same content identity from different local stores;
- production proves the complete import → persist → preview → render → delete/missing → same-category re-import → render flow.

## Out of scope

- backup/sync guarantees;
- automatic asset-library migration across origins/domains;
- project archive containing bytes;
- server-side asset persistence;
- non-image media.

## Done when

A production user can build and render a Story with their own bounded static local images, survive the v1 → v2 project-persistence transition, lose/recover assets predictably, and export a byte-free YAML that can be resolved in another environment by supplying the exact same files in the same categories.
