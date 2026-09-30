# WEB-007 — Static deployment and Web MVP verification

> Status: **Proposed**

## Goal

Prove that Tora Video Engine v0.2 can be deployed as a static web application and complete the full authoring → preview → browser render → download flow outside the developer machine.

## Deployment model

The production architecture for v0.2 is:

~~~text
Git repository
     ↓
static build
     ↓
HTML + JS + CSS + bundled/local assets
     ↓
static host
     ↓
user browser
     ↓
editing + preview + WebCodecs render + MP4 download
~~~

No Tora backend is required.

## Initial target

Netlify is the initial deployment target because the application can be served as static output.

The implementation should remain host-neutral enough that the same build artifact can also be served by alternatives such as Cloudflare Pages or another root-path static host.

For v0.2, the supported production deployment model assumes the app is served from the origin root (`/`). Repository-subpath deployments such as the default `/owner/repository/` shape of a GitHub Pages project site are intentionally out of scope because Remotion `staticFile()` asset resolution and the web bundle would require separate base-path handling and verification.

Do not advertise GitHub Pages project-site deployment as supported in v0.2 unless a later change adds and tests subpath-safe bundle and asset resolution.

Do not introduce Netlify Functions merely because Netlify is the first target.

## Build requirements

A clean checkout must support:

~~~bash
npm install
npm run web:build
~~~

The resulting static directory must contain everything required to load the application and its bundled/local assets.

If SPA route fallback configuration is needed, keep it minimal. Prefer a single-page root route if additional routing provides no v0.2 value.

## CI

Extend CI to verify at minimum:

- install;
- existing tests/lint/typecheck;
- existing CLI/reference render path;
- web production build.

Add lightweight browser-level automation if it can remain reliable and inexpensive.

A useful automated smoke flow is:

1. load the production web build;
2. confirm the canonical Story appears;
3. change one visual field;
4. confirm preview state changes;
5. verify invalid YAML is rejected and disables MP4 rendering;
6. discard/revert the invalid YAML and verify rendering becomes eligible again when browser capability allows it;
7. verify render capability/UI state is detectable;
8. verify a Story above 300 seconds / 9,000 frames remains schema-valid but browser render is disabled with the documented limit message;
9. create a dirty YAML buffer and verify switching to visual mode requires Apply, Discard, or Stay rather than enabling parallel visual edits;
10. simulate a localStorage write failure/quota error and verify Apply remains successful in memory while a persistence warning is shown;
11. create an invalid visual draft and verify switching to YAML requires Discard or Stay rather than losing the draft;
12. start a browser render and verify all Story/draft-mutating controls remain locked until completion/failure/cancel;
13. import a schema-valid Story with 201+ scenes and verify it never mounts into the visual editor/Player, remains identified as schema-valid, and receives the browser-limit/CLI guidance;
14. import a schema-valid Story above 9,000 frames and verify the same preview-suppression behavior;
15. perform several consecutive caption edits after Player mount, including rapid overlapping edits, and verify font readiness follows the newest caption without deadlock or stale completion.

A full MP4 render in every CI run is optional if browser/WebCodecs constraints make it flaky or expensive; the final release must still include a documented real-browser render verification.

## Manual web release checklist

Test the deployed site in current supported desktop browsers available to the project.

For each tested browser record:

- app loads;
- assets load;
- visual editor works;
- Player controls work;
- YAML import/apply works;
- invalid or unapplied YAML visibly blocks MP4 rendering until applied or discarded;
- dirty YAML cannot be bypassed by switching into editable visual mode without an Apply/Discard/Stay decision;
- an invalid visual draft cannot be bypassed by switching to YAML without a Discard/Stay decision;
- reload restores valid local state when persistence succeeds;
- storage quota/access failure is handled without crashing or rolling back the active Story, with a visible recovery warning;
- browser render capability result;
- if supported, canonical Story renders and downloads successfully;
- while rendering, authoring controls cannot mutate the Story or create a new draft;
- an over-budget Story is refused by browser authoring/preview before Player mount and by browser export without being reported as schema-invalid;
- repeated live caption edits continue rendering with the bundled font and never leave the Player stuck behind a stale render-delay handle.

At minimum, complete the golden end-to-end render in one supported browser.

## Golden end-to-end flow

Starting from a clean browser storage state:

1. open deployed app;
2. canonical/default Story loads;
3. inspect all available Tora poses/backgrounds/animations;
4. edit a caption;
5. change a pose;
6. reorder scenes;
7. preview reflects the valid Story;
8. export YAML;
9. reload and verify persistence;
10. render MP4;
11. download and inspect the result.

## Regression requirements

The web release must not regress v0.1:

- \`npm test\`;
- \`npm run lint\`;
- Remotion Studio;
- \`npm run video -- stories/friday-deploy.yaml\`;
- deterministic Story/timeline behavior.

## Documentation

Update the root README when implementation reaches this spec so it documents:

- local CLI workflow;
- web development workflow;
- production web URL;
- static deployment architecture;
- browser rendering requirements/limitations;
- link to \`docs/web/\` as the v0.2 source of truth.

## v0.2 completion checklist

- [ ] WEB-001 accepted
- [ ] WEB-002 accepted
- [ ] WEB-003 accepted
- [ ] WEB-004 accepted
- [ ] WEB-005 accepted
- [ ] WEB-006 accepted
- [ ] production static build succeeds
- [ ] deployed site loads without application backend
- [ ] visual editor flow passes
- [ ] browser authoring/preview budget blocks >200 scenes or >9,000 frames before Player mount
- [ ] live caption-font reload is safe across sequential and overlapping Story updates
- [ ] asset catalog flow passes
- [ ] YAML import/export flow passes
- [ ] persistence flow passes, including quota/access failure handling
- [ ] YAML/visual mode-switch conflict guards pass in both directions
- [ ] canonical browser MP4 render passes on a supported browser
- [ ] in-flight render authoring lock prevents stale-result downloads
- [ ] browser render budget guard passes at and above the 300-second / 9,000-frame boundary
- [ ] existing CLI render still passes
- [ ] README matches the implemented workflows

## Out of scope

- paid hosting optimization;
- custom backend;
- authentication;
- cloud persistence;
- cloud render;
- CDN/media pipeline beyond static hosting needs;
- production analytics;
- multi-user reliability/SLA;
- non-root/subpath hosting such as default GitHub Pages project sites.

## Done when

A user can visit the deployed static application and complete Tora's full v0.2 flow from Story authoring to a downloaded MP4, while the existing CLI remains intact.
