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

The implementation should remain host-neutral enough that the same build artifact can also be served by alternatives such as Cloudflare Pages or another static host.

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
7. verify render capability/UI state is detectable.

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
- reload restores valid local state;
- browser render capability result;
- if supported, canonical Story renders and downloads successfully.

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
- [ ] asset catalog flow passes
- [ ] YAML import/export flow passes
- [ ] persistence flow passes
- [ ] canonical browser MP4 render passes on a supported browser
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
- multi-user reliability/SLA.

## Done when

A user can visit the deployed static application and complete Tora's full v0.2 flow from Story authoring to a downloaded MP4, while the existing CLI remains intact.
