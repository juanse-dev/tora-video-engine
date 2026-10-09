# ASSET-006 — End-to-end verification and production gate

> Status: **Proposed**
>
> Depends on: ASSET-001 to ASSET-005. Read [README](./README.md) first (`INV-n`, constants, `D-n`).

## Goal

Close v0.3 with the cross-cutting checks that no single spec owns: persistence across reload, browser restart and a new build; YAML portability between browsers and to the CLI; cross-tab convergence; v0.2 compatibility. Then a **human** production gate.

Per-feature tests already live in their specs (inspection, library, integrity, readiness, UI, CLI). Do not duplicate them here.

## Part A — automated (implementing model)

### Files

| Action | Path | Purpose |
| --- | --- | --- |
| create | `tests/browser/local-assets-persistence.spec.mjs` | Reload, restart and build A → B (uses persistent contexts). |
| create | `tests/browser/local-assets-portability.spec.mjs` | Fresh-context YAML portability + v0.2 compatibility. |
| create | `tests/browser/local-assets-cross-tab.spec.mjs` | Two-tab convergence. |
| create | `playwright.persistence.config.mjs` | Config for specs that manage their own servers/contexts (no shared `webServer`). |
| modify | `package.json` | `"test:persistence": "playwright test --config=playwright.persistence.config.mjs"`. |
| modify | `.github/workflows/ci.yml` | Run `npm run test:persistence`. |
| modify | `docs/assets/README.md` + this file | Tick tasks, set statuses. |

### Tasks

- [ ] **A1. Persistence: reload, restart, build A → B.** In `local-assets-persistence.spec.mjs`:
  - start `vite preview` yourself on a fixed port (e.g. 4180) from `dist/web`; use `chromium.launchPersistentContext(<tmp user-data-dir>)`;
  - import `pose-magenta.png` and `background-cyan.jpg` through the UI, apply both, record the refs from the YAML editor;
  - **reload**: Story, My assets cards (with thumbnails) and Player images return without re-import;
  - **restart**: close the persistent context (whole browser), relaunch with the **same** user-data dir, open the same origin: same result; assert the new `blob:` URLs differ from the ones before restart (runtime sources were rebuilt, not persisted); fail the test if the user-data dir is not the same path;
  - **build A → B**: build a second copy (`vite build --outDir dist/web-b`), stop the first server, serve `dist/web-b` on the **same port**, reopen with the same profile: same result, and a browser MP4 render completes (reuse the golden's helpers);
  - the localStorage envelope is `version: 2` after a local ref was applied, and `version: 1` in a separate profile where only bundled edits were made.
- [ ] **A2. Portability and compatibility.** In `local-assets-portability.spec.mjs`:
  - context A imports both fixtures, applies them, exports YAML (download); the YAML contains the two `local:` refs and no `blob:`, `data:`, base64, or path strings;
  - fresh context B (new profile) imports that YAML: Story is valid, both refs show the missing card and Player placeholders, render is blocked;
  - in B, **Import matching file** with the exact fixtures resolves both with no Story change; render becomes eligible;
  - the same YAML renders through the CLI: covered by ASSET-005 e2e using the same fixture digests — assert here that `stories/ci-local-assets.yaml` refs equal the refs produced in context A;
  - v0.2 compatibility: every `stories/*.yaml` bundled Story imports, previews and exports byte-identically to v0.2 (compare against `serializeStorySource` output); a v1 envelope written by v0.2 code restores and stays v1 after bundled edits.
- [ ] **A3. Cross-tab convergence.** In `local-assets-cross-tab.spec.mjs` (two pages, one context):
  - import in A appears in B's My assets without reload;
  - rename in A updates B's label; B's Story YAML is unchanged;
  - delete of an in-use asset in A → B shows the missing card and placeholder;
  - the same file imported in A and B at nearly the same time → one card, one payload (check with the harness store or by counting cards).
- [ ] **A4. Release readiness.** Run every suite listed under Verify; tick all spec task lists; set every spec `Status` to **Implemented**; fill Part B's record table with "pending human gate". Then **stop and hand over to the user** for Part B.

### Verify

~~~bash
npm test
npm run lint
npm run web:build
npm run test:browser
npm run test:harness
npm run test:persistence
npm run test:cli-e2e
npx playwright test --config=playwright.browser-render.config.mjs
~~~

## Part B — production gate (human only)

An implementing model must not perform these steps; they need the real production site, a real browser profile and two real deployments. Deployment follows [docs/web/production-deployment.md](../web/production-deployment.md).

Use one browser profile for the whole gate and do not clear its site data.

1. **Deploy A** to `https://tora-video-engine.netlify.app`. Record commit and Netlify deploy ID.
2. Open production with an existing bundled project: it still works, and `localStorage["tora-video-engine:project"]` is still `version: 1`.
3. Import one custom pose and one custom background (use `tests/fixtures/local-assets/` files). They appear under **My assets**, separate from **Bundled**.
4. Apply both; the Player shows them. The stored envelope is now `version: 2`.
5. Reload: still available.
6. Fully quit and reopen the browser (same profile): Story, My assets and Player recover without re-import.
7. Export YAML: refs present; no bytes, `blob:` URLs or paths.
8. Render and download the MP4; it shows both custom images.
9. **Deploy B** (any later v0.3 commit) to the same origin. Record commit and deploy ID. Reopen in the same profile: assets still there without re-import; render again succeeds.
10. Delete an in-use asset: warning with scene count; Story shows the missing state; render blocked.
11. Re-import the exact same file in the same category: resolves automatically; render succeeds.
12. In DevTools → Network during steps 3–11: no request uploads image data to Netlify or anywhere else.
13. Run the CLI with the exported YAML and the same files in `local-assets/`: the MP4 shows the same images.

### Record

| Item | Value |
| --- | --- |
| Production URL | `https://tora-video-engine.netlify.app` |
| Deploy A (commit / Netlify ID) | pending |
| Deploy B (commit / Netlify ID) | pending |
| Browser + version, profile | pending |
| Fixture refs | pending |
| Reload / restart / A → B results | pending |
| Delete → re-import recovery | pending |
| No-upload check | pending |
| CLI parity | pending |

## Completion checklist

- [ ] ASSET-001 implemented (refs, persistence v1/v2, composition contract, readiness functions)
- [ ] ASSET-002 implemented (inspection, hashing, library, IndexedDB adapter, integrity)
- [ ] ASSET-003 implemented (My assets UI, recovery)
- [ ] ASSET-004 implemented (Player + browser render, race-safe render preparation, MP4 golden)
- [ ] ASSET-005 implemented (CLI scan/staging, `npm run assets`, e2e)
- [ ] Part A tasks A1–A4 pass
- [ ] Part B production gate recorded

## Done when

Part A is green in CI and Part B's record table is filled in by the user. Then v0.3 can be tagged `v0.3.0`.
