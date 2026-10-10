# GATE-001 — Automated deployed verification suite

> Status: **Implemented (pending first Linux CI run and Deploy Preview run)**
>
> Replaces the manual browser steps of the production gates (WEB-007 manual golden, ASSET-006 Part B) with a Playwright suite that runs against any deployed origin. The human only deploys (merges to `main`) and checks what exists only in Netlify, unless Netlify's API can check it too.

## Goal

One command verifies a deployed Tora origin end to end, in a real system Chrome with a dedicated profile, and writes a report that fills the release record tables:

~~~bash
npm run gate -- --url=prod --phase=A      # after Deploy A is published
npm run gate -- --url=prod --phase=B      # after Deploy B is published, same machine
~~~

What stays human:

- merging, which is what makes Netlify publish (Deploy A, then Deploy B);
- running the two commands and pasting the report into the docs;
- Netlify UI checks, unless `NETLIFY_AUTH_TOKEN` is set, in which case the runner checks them read-only through the Netlify API.

## Decisions

| # | Decision | Why |
|---|---|---|
| G1 | **Build identity in the page.** `vite.config.mts` gets a small `transformIndexHtml` plugin that injects `<meta name="tora-build" content="<commit>/<deployId>/<context>">`. The values are Netlify's build env `COMMIT_REF`, `DEPLOY_ID` and `CONTEXT`. Locally, commit = `git rev-parse --short HEAD` (or `unknown`), deployId = `local-<build epoch ms>`, context = `local`. | The suite can prove which deploy it tested, and that B ≠ A, without opening Netlify. The commit and deploy ID are not secret. |
| G2 | **Runner** `scripts/gate.mjs` (plain Node ESM), run as `npm run gate -- --url=<target> --phase=<A\|B> [--headed] [--only=<grep>]`. Targets: `prod` → `https://tora-video-engine.netlify.app`; `preview:<n>` → `https://deploy-preview-<n>--tora-video-engine.netlify.app`; `local`; or any `https://` URL. It sets env vars and spawns `playwright test --config=playwright.gate.config.mjs` via `process.execPath` + the Playwright CLI path (no bare `npx`). It exits with Playwright's code. | Works from PowerShell and bash alike; no env syntax for the user. |
| G3 | **Config** `playwright.gate.config.mjs`: `testDir: "tests/gate"`, `workers: 1`, no retries, `use.baseURL` = target. For `local` only, it has a `webServer`: phase A builds `dist/web` and serves it with `vite preview --port 4190 --strictPort`; phase B builds `--outDir dist/web-gate-b --minify false` and serves that on the same port. The config throws a clear message when the env is missing (so a bare `playwright test --config=…` explains itself). | `local` is how executors and CI exercise the suite without a deploy. |
| G4 | **State per target** in git-ignored `.gate/<target-slug>/` (slug: `prod`, `preview-<n>`, `local`, or the sanitized host): `profile/` (Chrome user-data dir), `state.json`, `artifacts/` (YAML, MP4s, decoded frames, network log), `report.md`. Phase A deletes and recreates its target dir. Phase B fails fast with a clear message if phase A's `state.json` is missing or was for another URL. | A → B needs the same profile across two runs, possibly hours apart. |
| G5 | **Browser.** System Chrome (`channel: "chrome"`), headless unless `--headed`, `chromium.launchPersistentContext(<profile>)` for the gate profile. Never the user's own Chrome profile. Player muted before any playback (#24). | H.264 encoding needs real Chrome; same as the persistence spec. |
| G6 | **Network guard** for every context the suite opens. A violation is any request whose method is not GET/HEAD/OPTIONS, unless it matches the allowlist; and any request whose body contains a PNG (`89 50 4E 47`) or JPEG (`FF D8 FF`) signature, or the bytes of a fixture, whatever the method or host. The allowlist starts with one entry: POST to a URL whose path ends in `/register-usage-point` (Remotion licence telemetry), with a body of at most 4096 bytes. Any new entry needs a ledgered ruling naming the request and why it carries no user data. Every non-GET request and every contacted host is logged to `artifacts/network.json` and summarized in the report. Violations fail the phase at the end, listing each one. | Automates "no request uploads image data" (Part B step 12) and makes it stricter than a human glance. |
| G7 | **Report.** `report.md` is Markdown the user pastes as is: (a) the ASSET-006 Part B Record table rows in the same order and wording as the spec table (Production URL, Deploy A, Deploy B, Browser + version and profile, Fixture refs, Reload / restart / A → B, Delete → re-import, No-upload check, CLI parity); (b) a WEB-007 golden checklist with pass/fail per item; (c) each failure with its message. Phase A writes the A rows and leaves the B rows "pending phase B"; phase B rewrites the whole report. The report never contains secrets or the token. | The user's only paperwork is a paste. |
| G8 | **Netlify API check (optional).** When `NETLIFY_AUTH_TOKEN` is set, the runner (not the browser) calls `GET https://api.netlify.com/api/v1/sites/tora-video-engine.netlify.app` and `GET …/deploys/<deployId from G1>` with `fetch`, read-only. It asserts the deploy is `state: "ready"`, that its `commit_ref` matches the page's commit, and, for `prod`, that it is the site's `published_deploy`. It also records whether the deploy has Functions (`available_functions` / `functions` empty). Without the token, the report says "Netlify check: manual (no token)". It never calls a mutating endpoint. | Covers "only what's in Netlify" with a CLI path, as the user asked. |
| G9 | **Production safety.** The suite only reads the static site and writes to its own profile. Each run causes Remotion telemetry for each browser render (about 5 per phase A, 2 per phase B), the same as a human doing the gate. Executors must not run the suite against `prod`; they use `local` and the PR's own Deploy Preview. | The production run is the user's call. |

## Tasks

### T1 — Build identity, runner, config, state and report plumbing

- [x] G1 plugin in `vite.config.mts`; a node:test unit test that builds the plugin's HTML transform with and without the Netlify env and checks the meta content. `tests/static-deploy.test.mjs` must still pass.
- [x] G2 `scripts/gate.mjs` + `"gate": "node scripts/gate.mjs"` in `package.json`; unit tests for argument parsing and target resolution (including a rejected `http://` non-local URL and an unknown alias).
- [x] G3 `playwright.gate.config.mjs`.
- [x] G4 `tests/gate/helpers/gateState.mjs` (target slug, dirs, phase A reset, phase B load with checks), `.gate/` and `dist/web-gate-b/` added to `.gitignore`.
- [x] G6 `tests/gate/helpers/networkGuard.mjs`: `attachNetworkGuard(context, {fixtureBuffers})` returning `{violations(), log(), hosts()}`; unit-testable pure classifier `classifyRequest({method, url, body})`, with node:test cases for: GET image allowed; telemetry POST ≤ 4096 allowed; telemetry POST > 4096 rejected; POST elsewhere rejected; PUT with PNG signature rejected; GET with a JPEG-signature body rejected.
- [x] G7 `tests/gate/helpers/report.mjs`: pure `renderReport(state, results)` → Markdown; node:test snapshot-style test for phase A only and A + B.
- [x] G8 `scripts/gateNetlify.mjs` with an injectable `fetch`; node:test cases with a fake fetch (ready + published; not published; commit mismatch; no token → manual).
- [x] `tests/gate/build-identity.spec.mjs`: opens the target, reads the meta, records it into state; fails with a clear message if the meta is missing (an old deploy predating G1).

### T2 — Production gate spec (ASSET-006 Part B, steps 2–13)

`tests/gate/local-assets-gate.spec.mjs`, one serial test per phase, gate profile (G4/G5), network guard on (G6).

**Phase A**
- [x] Step 2: in the fresh profile, write `tests/fixtures/v0.2/project-envelope.json` to `localStorage["tora-video-engine:project"]`, reload; the Story from the envelope is active and the Player renders; make one bundled caption edit; the envelope is still `version: 1`.
- [x] Steps 3–4: import `pose-magenta.png` and `background-cyan.jpg` through **My assets** onto one scene; both cards show under My assets with thumbnails, separate from Bundled; the Player shows them (blob images or a Player screenshot colour check); the envelope is `version: 2`; the refs in the YAML editor equal those in `stories/ci-local-assets.yaml`.
- [x] Step 5: reload → Story, cards and Player recover with no import.
- [x] Step 6: close the persistent context, relaunch with the same profile dir (assert the same path via a marker file); same result; the new `blob:` URLs differ from before.
- [x] Step 7: export YAML (download) → the two `local:` refs present; no `blob:`, `data:`, base64 runs, or path-like strings; saved to `artifacts/`.
- [x] Step 8: Render MP4 and download; metadata is H.264, 1080×1920, 30 FPS, 360 frames, video only; the decoded frame in the middle of the local-asset scene passes the shared colour-region checks (`POSE_MAGENTA_REGION`, `BACKGROUND_TOP_REGION`, `BACKGROUND_BOTTOM_REGION` with `isMagenta`/`isCyan`/`isYellow`), and a bundled scene's frame does not.
- [x] Step 13: `npm run video` on the exported YAML with `TORA_LOCAL_ASSETS_ROOT` pointing to a temp `poses/` + `backgrounds/` copy of the fixtures; same metadata and same colour-region result on the same scene; the CLI output goes to `artifacts/`, not `output/`.
- [x] Save `state.json` (URL, build identity A, refs, browser version, profile path, timestamps) and the report.

**Phase B**
- [x] Step 9: relaunch the same profile; the page's build identity differs from A's, otherwise fail with "Deploy B is not live yet: still <identity>"; assets present with no import; render again with the frame check.
- [x] Step 10: delete the in-use pose; the dialog says it is used by 1 scene; confirm; the missing card, the Player placeholder and the blocked-render message appear; the Story YAML is unchanged.
- [x] Step 11: **Import matching file** with the same pose → resolves; Story YAML unchanged; render again with the frame check.
- [x] Step 12: the network guard holds for both phases.
- [x] Rewrite the full report.

### T3 — WEB-007 golden spec, CLI parity and MP4 helpers

- [x] `tests/helpers/ffmpeg.mjs`: resolve the ffmpeg/ffprobe binaries shipped in the installed `@remotion/compositor-<platform>-<arch>[-<libc|msvc>]` package (no `npx`, works on Windows and Linux); `probeMp4(path)` → `{codec, width, height, fps, frames, hasAudio, durationSeconds}`; `decodeFrame(path, seconds, {width, height})` → raw RGB like the existing `decodeMp4Frame`. Switch `decodeMp4Frame` in `tests/browser/helpers/localAssetPage.mjs` to it without changing its signature or output, which also removes the known Windows `spawn npx ENOENT` failures. Keep any other `npx` spawns in existing specs as they are unless they only probe/decode MP4s.
- [x] `tests/gate/helpers/cliParity.mjs`: `renderWithCli({yamlPath, fixtures, outDir})` → output MP4 path; uses `process.execPath` + `scripts/render.ts` with `--experimental-strip-types`, honours `TORA_REMOTION_BROWSER_EXECUTABLE`.
- [x] `tests/gate/web-golden.spec.mjs` (phase A only; skipped in B), in its own fresh non-persistent system-Chrome context with the network guard, covering the WEB-007 manual checklist on the bundled canonical Story: app loads with bundled poses and backgrounds; caption edit; pose change; scene reorder; the Player follows the Active Story; YAML export; reload restores the edits; render capability is ready; render + download with metadata (video-only H.264, 1080×1920, 30 FPS, 360 frames / 12 s); Cancel Render aborts and unlocks authoring; a pending draft blocks rendering; an in-flight render locks authoring until it settles. Reuse the patterns of `tests/browser/browser-rendering.spec.mjs` and `visual-editor.spec.mjs`.

### T4 — Docs and CI

- [x] `docs/release/README.md`: the operator guide. What to merge, when to run each phase, what the report contains, where to paste it, the optional token, and the only remaining manual Netlify checks.
- [x] Point `docs/web/production-deployment.md` "Manual release verification" and ASSET-006 Part B at the suite (keep the existing records as history).
- [ ] CI: after the persistence step, run `npm run gate -- --url=local --phase=A` then `--phase=B`. Raise `timeout-minutes` only if the measured job time needs it, and record the measured time in the PR. (The step is in `.github/workflows/ci.yml`; the measured time waits for the first Linux CI run.)
- [x] README: one line under the web section linking the guide.

## Verify

- `npm test`, `npm run lint`, `npm run web:build`.
- `npm run gate -- --url=local --phase=A` then `--phase=B`, both green, with the report written.
- Once against the PR's own Deploy Preview: phase A on push N, phase B after push N+1 (`--url=preview:<n>`), both green.
- Mutation checks, each recorded with its observed failure: (1) phase B against the same build as A fails with "not live yet"; (2) an injected `fetch(..., {method: "POST", body: <png bytes>})` in the page fails the network guard; (3) deleting the asset before step 5 fails the reload check.
- Existing suites unchanged: `test:browser`, `test:harness`, `test:persistence`, browser-render config, `test:cli-e2e`.

## Implementation notes

Rulings made while building this (the full ledger is in the SDD progress file):

- R1: the golden spec was first built against a temporary local config and request listener, then switched to the real `networkGuard` and gate config once T1 landed.
- R2: T2 consumed T3's `renderWithCli`, `probeMp4` and `decodeFrame` under fixed names and paths (`tests/gate/helpers/cliParity.mjs`, `tests/helpers/ffmpeg.mjs`).
- R3: parallel lanes used separate local ports (4190 in the main checkout, 4191 in the worktree); the committed config uses 4190 only.
- R4: Cancel Render accepts the app's existing `cleanup-blocked` outcome and records the actual end state; not a GATE regression.
- R5: the golden spec records its network-guard result under the non-table key `goldenNetwork`; only the gate spec owns the "No-upload check" Record row.
- R6: the gate deletes only `Default/History*` from its dedicated profile before launch, because Chrome 154 on Windows crashes on a download when History lists an earlier session's download; site data is untouched.
- R7: phase B snapshots the gate profile to `profile-before-b/` on its first run and restores it on reruns, so a flaky step 10 or 11 does not cost another production deploy cycle.
- R8: phase A refuses to delete a passed phase A without `--fresh`, and the MP4 checks assert exactly one video stream.

Changes from the final whole-branch review:

- A target slug can no longer escape `.gate/`: custom-host slugs are `host-<host>`, a slug must match `[a-z0-9.-]+` and not be empty, `.` or `..`, and every delete asserts the target dir is a direct child of `.gate/`.
- The runner also reads `npm_config_url`, `_phase`, `_only`, `_headed` and `_fresh` when argv has no `--url`, because Windows PowerShell 5.1's `npm.ps1` drops the `--`.
- Phase B checks that phase A passed before it builds or launches a browser.
- The optional Netlify API check does not cover Edge Functions; they stay a manual Netlify UI check, and the report line says so.
