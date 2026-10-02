# Production web deployment

Tora Video Engine v0.2 is designed to ship as a root-hosted static Vite application. The browser performs authoring, preview, local persistence, and H.264 MP4 rendering; no Tora application server, serverless function, database, authentication service, or cloud render queue is required.

## Netlify target

The repository includes a root-level `netlify.toml` with the production contract:

~~~toml
[build]
  command = "npm run web:build"
  publish = "dist/web"

[build.environment]
  NODE_VERSION = "22"
~~~

Netlify installs dependencies from the repository root, runs the existing Vite production build, and publishes only `dist/web`.

The Vite configuration intentionally uses `base: "/"`. v0.2 therefore supports deployment from the origin root. Repository-subpath hosting such as a default GitHub Pages project site is not a supported production shape.

Tora v0.2 has one application route, `/`, so no SPA history fallback is required. Do not add Netlify Functions or a catch-all rewrite unless later routing work actually needs them.

## Production build verification

From a clean checkout:

~~~bash
npm ci
npm test
npm run lint
npm run web:build
npm run test:browser
~~~

The CI workflow additionally verifies the built web artifact and browser-render golden before the branch is considered healthy.

The deploy-ready directory is:

~~~text
dist/web/
~~~

It must contain `index.html`, the bundled Vite assets, Tora character poses, and backgrounds.

## Browser rendering requirements

The web application detects browser support at runtime. MP4 export is only offered when all of the following are available:

- the Web Locks API, used to serialize same-origin renders;
- Remotion client-side rendering capability for H.264 MP4;
- Remotion resolves the output target to `web-fs`;
- the active Story satisfies the same browser authoring limits used by preview and persistence.

If those requirements are not met, visual/YAML authoring, preview, YAML export, and the local CLI remain available.

The current Remotion client-render documentation states that `@remotion/web-renderer` uses WebCodecs and is stable from Remotion 4.0.491. Tora remains pinned to Remotion 4.0.529 for v0.2.

## Remotion license basis

Verified on **2026-10-01** against the current official Remotion License & Pricing and License FAQ pages:

- individuals and organizations/teams of up to 3 people are currently eligible for the Free License, subject to Remotion's terms;
- eligible Free License users may use automation and commercial workflows without buying a Company License;
- organizations that do not qualify for the Free License need a Company License;
- Remotion currently describes **Remotion for Automators** as **$0.01 per render with a $100/month minimum**;
- video editors and applications embedding automated rendering fall under the Automators use case.

Official references:

- https://www.remotion.dev/docs/license/pricing
- https://www.remotion.dev/docs/license/faq

For the current Tora Video Engine deployment, the applicable basis is **Remotion Free License because the project is operated by an individual**. The Company License / Automators pricing above is retained only as a future-change reference if ownership or operation moves to an organization that no longer qualifies for the Free License.

This verification is a release record, not a permanent pricing guarantee. Re-check the official terms immediately before every production launch or material licensing change.

### License key

The browser build may receive:

~~~text
VITE_REMOTION_LICENSE_KEY
~~~

Vite environment variables are public client-side configuration. Never put a private/server-side secret in this variable.

Use `free-license` only when the deployment has verified current Free License eligibility. Otherwise configure the client-safe key required by the applicable Remotion license.

## Telemetry and privacy

Remotion's current client-side rendering documentation states that every client-side render emits a telemetry event, even when no license key is configured. The current Remotion licensing/privacy documentation describes telemetry as including operational/license metadata such as:

- end-user IP address;
- page/domain name;
- production/development classification;
- video/still classification.

Remotion states that rendered media, Story content, project source, and rendered output are not sent through this telemetry path.

Official references:

- https://www.remotion.dev/docs/client-side-rendering
- https://www.remotion.dev/docs/license/faq
- https://www.remotion.dev/docs/dpa
- https://www.remotion.dev/docs/privacy

A Tora production deployment must therefore not claim to be fully offline or zero-network. The production privacy notice and any restrictive Content Security Policy must account for Remotion licensing telemetry.

Do not add a strict `connect-src` CSP until the exact telemetry endpoint used by the pinned production bundle has been verified in the deployed browser. Blocking telemetry must not be treated as a supported licensing strategy.

## Manual release verification

WEB-007 is not accepted merely because the static build succeeds. Before declaring v0.2 complete, record at least one deployed real-browser golden flow:

1. open the deployed root URL from a clean browser state;
2. confirm bundled poses/backgrounds and the canonical Story load;
3. edit a caption, pose, and scene order;
4. confirm Player preview follows the active validated Story;
5. export YAML;
6. reload and confirm persistence;
7. confirm browser render capability state;
8. render and download the canonical MP4 on a supported browser;
9. verify the MP4 is video-only H.264, 1080×1920, 30 FPS, 360 frames / 12 seconds;
10. confirm cancellation, pending-draft blocking, and render authoring lock behavior;
11. record the browser/version, deployed URL, deployment commit, Remotion license basis, and result.

The automated WEB-001…006 tests remain the regression suite; this checklist is the production-host verification that cannot be replaced by a local preview server alone.

## Production release record

Fill this in when the first production deployment is verified:

| Field | Value |
| --- | --- |
| Deployment commit | Pending WEB-007 production deploy after merge |
| Netlify project | https://app.netlify.com/projects/tora-video-engine |
| Production URL | https://tora-video-engine.netlify.app |
| Host | Netlify; GitHub repository linked, production branch `main` |
| Browser golden | Pending |
| Remotion license basis | Free License — individual; reconfirm immediately before production deploy |
| License terms last checked | 2026-10-01 |
| Telemetry/privacy review | Pending deployed-origin verification |
| WEB-007 status | In progress |
