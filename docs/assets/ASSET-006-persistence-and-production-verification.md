# ASSET-006 — End-to-end verification and production gate

> Status: **Implemented** (Part A green in CI; Part B production gate recorded 2026-10-10)
>
> Depends on: ASSET-001 to ASSET-005. Read [README](./README.md) first (`INV-n`, constants, `D-n`).

## Goal

Close v0.3 with the cross-cutting checks that no single spec owns: persistence across reload, browser restart and a new build; YAML portability between browsers and to the CLI; cross-tab convergence; v0.2 compatibility. Then a **human** production gate.

Per-feature tests already live in their specs (inspection, library, integrity, readiness, UI, CLI). Do not duplicate them here.

## Part A — automated (implementing model)

### Files

| Action | Path | Purpose |
| --- | --- | --- |
| create | `tests/persistence/local-assets-persistence.spec.mjs` | Reload, restart and build A → B (persistent contexts; manages its own servers). |
| create | `tests/browser/local-assets-portability.spec.mjs` | Fresh-context YAML portability + v0.2 compatibility (normal production-preview suite). |
| create | `tests/browser/local-assets-cross-tab.spec.mjs` | Two-tab convergence (normal production-preview suite). |
| create | `playwright.persistence.config.mjs` | `testDir: "tests/persistence"`, no shared `webServer`. Lives outside `tests/browser/` so `npm run test:browser` never runs it. |
| modify | `package.json` | `"test:persistence": "playwright test --config=playwright.persistence.config.mjs"`. |
| modify | `.github/workflows/ci.yml` | Run `npm run test:persistence`. |
| modify | `docs/assets/README.md` + this file | Tick tasks, set statuses. |

### Tasks

- [x] **A1. Persistence: reload, restart, build A → B.** In `tests/persistence/local-assets-persistence.spec.mjs`:
  - start `vite preview` yourself on a fixed port (e.g. 4180) from `dist/web`; use `chromium.launchPersistentContext(<tmp user-data-dir>)`;
  - import `pose-magenta.png` and `background-cyan.jpg` through the UI, apply both, record the refs from the YAML editor;
  - **reload**: Story, My assets cards (with thumbnails) and Player images return without re-import;
  - **restart**: close the persistent context (whole browser), relaunch with the **same** user-data dir, open the same origin: same result; assert the new `blob:` URLs differ from the ones before restart (runtime sources were rebuilt, not persisted); fail the test if the user-data dir is not the same path;
  - **build A → B**: build a second copy (`vite build --outDir dist/web-b`), stop the first server, serve `dist/web-b` on the **same port**, reopen with the same profile: same result, and a browser MP4 render completes (reuse the golden's helpers);
  - the localStorage envelope is `version: 2` after a local ref was applied, and `version: 1` in a separate profile where only bundled edits were made.
- [x] **A2. Portability and compatibility.** In `local-assets-portability.spec.mjs`:
  - context A imports both fixtures, applies them, exports YAML (download); the YAML contains the two `local:` refs and no `blob:`, `data:`, base64, or path strings;
  - fresh context B (new profile) imports that YAML: Story is valid, both refs show the missing card and Player placeholders, render is blocked;
  - in B, **Import matching file** with the exact fixtures resolves both with no Story change; render becomes eligible;
  - the same YAML renders through the CLI: covered by ASSET-005 e2e using the same fixture digests — assert here that `stories/ci-local-assets.yaml` refs equal the refs produced in context A;
  - v0.2 compatibility: the bundled Stories `stories/friday-deploy.yaml`, `stories/ci-smoke.yaml` and `stories/demo-reel.yaml` (explicit list — `stories/ci-local-assets.yaml` uses local refs and is excluded) each import, previews and exports byte-identically to v0.2 (compare against `serializeStorySource` output); a v1 envelope written by v0.2 code restores and stays v1 after bundled edits.
- [x] **A3. Cross-tab convergence.** In `local-assets-cross-tab.spec.mjs` (two pages, one context):
  - import in A appears in B's My assets without reload;
  - rename in A updates B's label; B's Story YAML is unchanged;
  - delete of an in-use asset in A → B shows the missing card and placeholder;
  - the same file imported in A and B at nearly the same time → one card, one payload (check with the harness store or by counting cards).
- [x] **A4. Release readiness.** Run every suite listed under Verify; tick all spec task lists; set every spec `Status` to **Implemented**; fill Part B's record table with "pending human gate". Then **stop and hand over to the user** for Part B.
  - Note: ASSET-006's own Status stayed "Part A implemented; Part B pending human gate" until Part B was recorded, and "Part A tasks A1–A4 pass" is confirmed by PR #26's Linux CI.

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

> **Automated since GATE-001.** `npm run gate -- --url=prod --phase=A` (after Deploy A) and `--phase=B` (after Deploy B) perform steps 2 to 13 in a dedicated Chrome profile and write the Record table below as `report.md`; see [docs/release/README.md](../release/README.md). Still human: merging to publish Deploy A and Deploy B (steps 1 and 9, publishing only), running the two commands, pasting the report, and the Netlify UI checks unless `NETLIFY_AUTH_TOKEN` is set. The numbered steps below stay as the specification of what the suite checks, and the record below is history.

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
| Deploy A (commit / Netlify ID) | `d4aa69a` (merge of #25) / `6ac9d19a7ca32e0009507632` |
| Deploy B (commit / Netlify ID) | `da946d8` (merge of #26) / `6aca48364ca0ea00081ccb99`. #26 changed only tests and docs, so B serves the same app bundle as A; a genuinely different bundle on one origin is covered by A1 in CI |
| Browser + version, profile | Chrome 154.0.8037.98, Windows 11 desktop; the user's existing profile (v1 project from v0.2), site data never cleared |
| Fixture refs | `local:pose:sha256:e572d1a4c4908ab8ee783693c99a050b45a28fa030e48e645b64e354651a0ca7`, `local:background:sha256:3470d1d2f387e4e55b88e8139f84bde89dc8a9b015827ec638ecf5af9a8fdc06` (equal to `stories/ci-local-assets.yaml`) |
| Reload / restart / A → B results | Pass. Envelope `version: 1` before import, `version: 2` after applying both; reload, full browser restart and Deploy B kept Story, My assets and Player without re-import. Browser MP4 (H.264, 1080×1920, 30 FPS, 12 s) shows the magenta pose and cyan/yellow background in scene 3; render after Deploy B succeeded |
| Delete → re-import recovery | Pass. Delete warned "used by 1 scene"; scene 3 showed the missing placeholder and Render MP4 was blocked; **Import matching file** with the same file resolved it without a Story change and render succeeded |
| No-upload check | Pass. DevTools Network (Preserve log) during steps 3–11: the only outgoing POST was Remotion's `register-usage-point` licence telemetry (0.2 kB); every other request was a GET of the app bundle, bundled images or a local `blob:` URL |
| CLI parity | Pass. `npm run video` with the exported YAML and the two fixtures in a `local-assets`-style folder (`TORA_LOCAL_ASSETS_ROOT`) rendered 360 frames; scene 3 shows the same magenta pose and cyan/yellow background as the browser MP4 |

## Implementation notes

- R1: the persistence spec launches system Chrome (`channel: "chrome"`, persistent contexts), because bundled Chromium cannot encode H.264 and A1 completes a real MP4 render.
- R2: any browser test that starts Player playback mutes the Player first (issue #24).
- R3: in the bundled-Chromium suite, "render is eligible" means the local-asset render block is gone (no `data-local-asset-block`, no missing cards or placeholders, render state idle); the Render MP4 button is not asserted.
- R4: the v0.2 baseline is commit `962e030`; `tests/fixtures/v0.2/` holds real v0.2 YAML exports and a v1 envelope generated from it (see its README).
- R5: the near-simultaneous cross-tab import is checked by one card per tab plus an in-page IndexedDB read of one `assets` row and one payload.
- R6: build B of the A → B check is built with `--minify false`, so it is a genuinely different bundle on the same origin.

## Completion checklist

- [x] ASSET-001 implemented (refs, persistence v1/v2, composition contract, readiness functions)
- [x] ASSET-002 implemented (inspection, hashing, library, IndexedDB adapter, integrity)
- [x] ASSET-003 implemented (My assets UI, recovery)
- [x] ASSET-004 implemented (Player + browser render, race-safe render preparation, MP4 golden)
- [x] ASSET-005 implemented (CLI scan/staging, `npm run assets`, e2e)
- [x] Part A tasks A1–A4 pass
- [x] Part B production gate recorded

## Done when

Part A is green in CI and Part B's record table is filled in by the user. Then v0.3 can be tagged `v0.3.0`.
