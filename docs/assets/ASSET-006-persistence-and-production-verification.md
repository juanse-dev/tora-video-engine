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

Browser durable project state uses the lazy compatibility boundary defined in ASSET-001:

~~~text
v1 bundled-only envelope
        │
        ├── bundled-only v0.3 reads/writes → stays v1
        │
        └── first successful write containing local ref
                         ↓
                  atomic promotion to v2
~~~

The Story content remains semantically identical except for the user's intentional local refs. ASSET-006 verifies the lazy promotion and cross-version safety; it does not redefine them.

Rollback compatibility is preserved for users who only open/edit bundled-only Stories in v0.3. Once a slot has successfully promoted to v2, an old v0.2 tab must see it as unsupported-version/recovery. The existing unversioned persistence Web Lock continues to protect the shared physical Story/recovery slots.

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

1. restore/validate the v1/v2 Story envelope using the ASSET-001 compatibility boundary and existing recovery safeguards, without eagerly rewriting a valid bundled-only v1 envelope;
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

Asset readiness and the aggregate custom-asset browser budget are evaluated **after** Story schema/browser authoring policy and before loading original local Blobs.

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

The local-image resource limits (≤25 MiB source bytes, ≤8192 px per side, ≤50 MP, static PNG/JPEG/WebP only) apply per imported/source asset.

Separately, the browser enforces the ASSET-001 aggregate local-asset budget on distinct refs/digests: ≤64 local refs, ≤256 MiB source bytes, and ≤200 MP. A Story exceeding that aggregate budget remains schema-valid/exportable for CLI use but must not load original Blobs into Player/render.

## Loss-risk semantics

Importing/deleting/renaming local library entries is durable library state, not a pending Story draft.

However:

- applying a local asset to a scene changes the Story and follows normal Story loss-risk/autosave rules;
- deleting an in-use asset leaves Story refs unchanged and therefore does not count as silently discarding Story work;
- if the local library write itself fails, the operation reports failure and prior library state remains authoritative.

No browser unload warning is required solely because a completed IndexedDB asset mutation has already committed durably.

## Project persistence compatibility tests

Cover the lazy v1 → v2 boundary explicitly:

- a persisted v1 bundled-only Story opens in v0.3 without rewriting its durable envelope;
- bundled-only edits/autosaves from v0.3 keep the durable slot at v1;
- after those bundled-only v0.3 edits, a simulated v0.2 reader still restores the Story normally;
- importing assets into My assets without applying a local ref does not promote the project envelope;
- first successful durable write of a Story containing a local ref promotes v1 → v2 atomically under the persistence-writer lock;
- failed first-local-ref write preserves the previous v1 durable envelope and marks the new Active Story unpersisted/loss-risk;
- a secondary/session-only tab cannot perform the promotion;
- once durable state is v2, later bundled-only Story writes remain v2 rather than automatically downgrading;
- a simulated v0.2 reader presented with v2 follows unsupported-version/recovery behavior.

## Browser asset metadata / integrity verification

Cover the bounded metadata-first design explicitly:

- over-budget Story evaluation reads only `assets` + `payloadMeta` records and performs zero `blobs` reads before rejecting;
- `payloadMeta` contains byte size/dimensions needed for budget calculation without embedding the Blob;
- opening My assets with a large library fetches at most one 50-row metadata page initially, plus only that page's bounded thumbnails;
- total count is obtained independently without materializing all asset rows;
- paging/window navigation fetches additional bounded metadata pages on demand;
- valid image-B bytes stored under digest-A are detected by SHA-256 mismatch and never reach Player/render as asset A;
- Blob A with correct digest A but payloadMeta MIME/dimensions deliberately falsified is detected before runtime-source creation;
- a Story whose corrupt payloadMeta under-reports pixels enough to pass the metadata preflight is re-evaluated from verified real dimensions and blocked if it exceeds 200 MP;
- integrity hashing/inspection is sequential (`MAX_CONCURRENT_INTEGRITY_CHECKS = 1`), and instrumentation on a fixture near the 256-MiB Story budget proves at most one ≤25-MiB source payload is materialized for verification at a time;
- successful verified descriptors may be cached only for the current page session/invalidation generation;
- local/cross-tab mutation of a digest invalidates the integrity cache before later reuse;
- exact-file same-category reimport repairs `payloadMeta`, original Blob, and thumbnail and restores readiness without Story mutation.

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

The test root must also verify the ASSET-005 path-safety rule:

- a symlink-to-file inside `poses/` whose target is outside the category root is skipped and never read/hashed;
- a symlink-to-directory inside `backgrounds/` whose target is outside the category root is not traversed;
- ordinary nested regular files still resolve.

Use platform/CI guards where symlink creation requires OS support/permissions, but the scanner policy itself remains no-follow on every platform.

Use the same source-controlled fixture bytes in a temporary local-asset root.

At least one parity fixture must have valid PNG/JPEG/WebP bytes with an absent or intentionally incorrect filename extension. Browser import and CLI indexing must both accept it by content and compute the identical category-scoped ref.

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
- asset row present but payloadMeta/Blob and/or thumbnail missing/corrupt, followed by exact-file same-category reimport that repairs backing data without Story mutation;
- Blob row present without payloadMeta/asset metadata;
- payloadMeta present with Blob bytes whose SHA-256 does not equal the digest key;
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

1. app opens with an existing bundled Story and confirms a persisted bundled-only v1 project remains v1 until a local ref is actually persisted;
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
- [ ] existing bundled YAML/Story content remains unchanged; bundled-only persisted v1 projects stay v1, and first successful local-ref persistence promotes atomically to v2
- [ ] browser local library persists across reload on same origin
- [ ] catalog metadata is paged at ≤50 rows and never requires whole-library getAll/materialization
- [ ] bundled and My assets are separate in UI
- [ ] static PNG/JPEG/WebP imports reject APNG/animated WebP and enforce 25 MiB pre-read, ≤8192 px/side, and ≤50 MP limits
- [ ] SHA-256 dedup works and exact duplicate reimport repairs missing/corrupt original Blob/thumbnail backing
- [ ] labels rename without changing refs
- [ ] YAML contains refs only, no bytes/blob URLs/paths
- [ ] delete-in-use warning passes
- [ ] missing refs preserve Story and block render
- [ ] exact-file same-category re-import resolves missing ref automatically
- [ ] ASSET-001 pinned-Remotion runtime-source transport gate is accepted before storage/UI rollout
- [ ] aggregate browser local-asset budget blocks >64 refs / >256 MiB / >200 MP using only assets/payloadMeta records and zero Blob-store reads before rejection while preserving YAML/CLI recovery
- [ ] original Blob SHA-256/size/actual format/dimensions integrity is verified before first runtime use per session/invalidation generation
- [ ] aggregate pixel/byte budget is revalidated from verified payload descriptors before runtime-source creation
- [ ] integrity verification is sequential with at most one ≤25-MiB source payload materialized/hashed at once
- [ ] custom pose/background Player flow passes
- [ ] custom pose/background browser MP4 golden passes
- [ ] fresh-browser YAML portability flow passes
- [ ] CLI resolves same refs from local asset folders
- [ ] required local asset helper prints full canonical copy/pasteable refs
- [ ] CLI missing-asset diagnostics pass
- [ ] CLI scanner skips file/directory symlinks and does not traverse outside local-assets category roots
- [ ] CLI/browser custom-asset parity golden passes, including extensionless/misnamed valid-content fixture
- [ ] cross-tab library convergence and frozen-render snapshot behavior pass
- [ ] production remains static-hosted/backend-free
- [ ] production custom-asset golden passes

## Acceptance criteria

- v0.2 bundled Story/render behavior remains stable; bundled-only v1 persistence remains rollback-compatible until first local-ref use, and lazy v1 → v2 promotion is verified;
- v0.3 local assets survive ordinary same-origin reload/deploy use;
- loss/corruption of local bytes or payload metadata never corrupts or silently changes Story meaning; digest/format/dimension mismatches are blocked and verified resource metadata is used for the final browser budget;
- browser and CLI resolve the same content identity from different local stores;
- production proves the complete import → persist → preview → render → delete/missing → same-category re-import → render flow.

## Out of scope

- backup/sync guarantees;
- automatic asset-library migration across origins/domains;
- project archive containing bytes;
- server-side asset persistence;
- non-image media.

## Done when

A production user can build and render a Story with bounded static local images, keep bundled-only v1 projects rollback-compatible until first local-ref persistence, browse a large library through bounded metadata pages, reject digest-mismatched backing bytes before render, recover missing/corrupt backing data by exact-file reimport, and export a byte-free YAML that resolves identically in browser and CLI from the same content regardless of filename extension.
