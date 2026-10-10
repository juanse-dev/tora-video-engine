# Release verification guide

One command checks a deployed Tora origin end to end in a real system Chrome and writes a report you paste into the release docs. It replaces the manual browser steps of the production gates ([WEB-007](../web/production-deployment.md#manual-release-verification) manual golden, [ASSET-006 Part B](../assets/ASSET-006-persistence-and-production-verification.md)). The design is in [GATE-001](GATE-001-deployed-verification-suite.md).

## What stays human

- **Merging.** Netlify publishes when a commit lands on `main`: that is Deploy A, then later Deploy B.
- **Running the two commands** below and **pasting the report** into the docs.
- **The Netlify UI checks** (see [Netlify checks](#netlify-checks)), unless you set `NETLIFY_AUTH_TOKEN`, in which case the runner checks them read-only.

Everything else (editing, persistence across reload, browser restart and a new deploy, rendering, downloads, the network check, CLI parity) is the suite.

Agents and automated executors must never run the suite against `prod`; production runs are the owner's call (see [Remotion telemetry](#remotion-telemetry-production-safety)).

## Requirements

- Node 22 and `npm ci` done in this checkout.
- Google Chrome installed (system Chrome, `channel: "chrome"`). Do not run `npx playwright install`: bundled Chromium cannot encode H.264 and is not used.
- The gate uses its own dedicated Chrome profile under `.gate/`. It never touches your own Chrome profile.

## Release procedure

1. **Merge the release PR to `main`.** Wait until Netlify shows that deploy as **Published** (this is Deploy A). The deploy under test must include the build identity (GATE-001 G1, the `tora-build` meta in `index.html`); a build that predates it makes phase A fail with "the deployed build predates the GATE-001 build identity".
2. **Run phase A** from the repository root:

   ```bash
   npm run gate -- --url=prod --phase=A
   ```

3. **Check `.gate/prod/report.md` first.** Merge the commit for Deploy B only after its result line reads `PHASE A PASSED (phase B pending)`. If phase A failed, fix that before Deploy B: once Deploy B is live, rerunning phase A tests the wrong build and costs another deploy (a Deploy C), see [Troubleshooting](#troubleshooting).
4. **Merge a later commit to `main`** and wait for Netlify to publish it (Deploy B). Do not clear `.gate/prod/`, and run phase B on the same machine, in the same checkout, as phase A. The hours between the two runs do not matter.
5. **Run phase B**:

   ```bash
   npm run gate -- --url=prod --phase=B
   ```

6. Open `.gate/prod/report.md` and paste it (see below).

Phase A deletes and recreates `.gate/<target>/`, so never re-run phase A between A and B. To protect that window, phase A refuses to start when `.gate/<target>/state.json` shows a phase A that passed and phase B has not completed (it has not run, failed, or was interrupted), unless you pass `--fresh`. Use `--fresh` only when you really mean to throw that state and profile away, for example a rehearsal you are repeating. Once phase B has completed and passed, the phase A of the next release starts without `--fresh`.

Phase B stops immediately, before it builds or opens a browser, if phase A's state is missing, was recorded for another URL, or phase A did not pass.

A run with `--only` never counts as a passed phase: the report reads INCOMPLETE, phase B refuses a partial phase A, and a partial phase B does not close the A to B window. The same rule decides the report verdict and these guards, and a failed Netlify API check also keeps a phase from counting as passed.

## Commands

```bash
npm run gate -- --url=<target> --phase=<A|B> [--headed] [--only=<grep>] [--fresh]
```

**Windows PowerShell 5.1.** Its `npm.ps1` shim drops the `--`, so npm treats `--url=...` as its own options (and prints `npm warn Unknown cli config "--url"`). The runner copes: it reads the flags npm exports as `npm_config_url`, `npm_config_phase`, `npm_config_only`, `npm_config_headed` and `npm_config_fresh`, so the commands in this guide work as written and the warnings are harmless. If you still see `--url is required`, run the same command through `npm.cmd`, or skip npm:

```powershell
npm.cmd run gate -- --url=prod --phase=A
node scripts/gate.mjs --url=prod --phase=A
```

| Option | Meaning |
| --- | --- |
| `--url=prod` | `https://tora-video-engine.netlify.app` |
| `--url=preview:<n>` | The Deploy Preview of pull request `<n>`: `https://deploy-preview-<n>--tora-video-engine.netlify.app`. Use this to rehearse the suite on a PR before merging. |
| `--url=local` | Builds and serves the app on `http://127.0.0.1:4190` (phase A builds `dist/web`; phase B builds a different, unminified copy into `dist/web-gate-b`). Needs no deploy. |
| `--url=https://<origin>` | Any other https origin (state under `.gate/host-<host>/`). `http://` is accepted only for loopback hosts. |
| `--phase=A` / `--phase=B` | Phase A: after Deploy A. Phase B: after Deploy B. |
| `--headed` | Show the browser window instead of running headless. |
| `--fresh` | Phase A only. Start over even though `.gate/<target>/` holds a passed phase A whose phase B has not completed. Without it, phase A refuses and tells you so. |
| `--only=<grep>` | Run only the tests whose title matches (Playwright `--grep`). For debugging only: phase A still wipes `.gate/<target>/` first, and the report lists the other items as not recorded, so a full phase A must run before phase B. |

The runner exits with Playwright's exit code (non-zero when any check fails, or when the optional Netlify check fails).

## What the suite checks

**Phase A**

- The page's build identity (commit, Netlify deploy ID, context), recorded from `<meta name="tora-build">`.
- The WEB-007 golden checklist on the bundled canonical Story, in a fresh non-persistent Chrome context: bundled assets load, caption/pose/reorder edits, the Player follows the Active Story, YAML export, reload restores the edits, render capability, render and download (video-only H.264, 1080×1920, 30 FPS, 360 frames / 12 s), Cancel Render, a pending draft blocks rendering, an in-flight render locks authoring.
- ASSET-006 Part B steps 2 to 8 and 13 in the gate profile: v1 project, import of the two fixtures, reload, browser restart on the same profile, YAML export, MP4 with both images, CLI parity with `npm run video`.

**Phase B** (same profile)

- The build identity differs from phase A's, otherwise it fails with `Deploy B is not live yet: still <identity>`.
- Assets are still there without re-import, render again, delete an in-use asset (blocked render, Story unchanged), **Import matching file** recovers it, render again.

**Both phases:** a network guard watches every browser context. A violation is any request that is not GET/HEAD/OPTIONS (except Remotion's licence telemetry `register-usage-point`, 4096 bytes or less), and any request body that contains a PNG or JPEG signature or the bytes of a fixture. Violations fail the phase and are listed in the report. Deploy Preview pages load Netlify's drawer, whose two POSTs (`sessions.bugsnag.com/` and `app.netlify.com/.../deploys/<id>/views`, 4096 bytes or less) are allowed only when the page's build context is known and is not `production`, and the report says so.

## The report

The report is written to **`.gate/<target>/report.md`** (`prod`, `preview-<n>`, `local`, or `host-<sanitized host>`), next to `state.json`, `profile/` and `artifacts/` (exported YAML, MP4s, decoded frames, `network.json`). `.gate/` is git-ignored.

It contains, in this order:

1. A result line (`PASS`, `FAIL`, `INCOMPLETE` or `PHASE A PASSED (phase B pending)`), the URL and the time span of each phase.
2. **ASSET-006 Part B Record**: the table rows in the same order and wording as the record table in the spec (Production URL, Deploy A, Deploy B, Browser + version and profile, Fixture refs, Reload / restart / A → B results, Delete → re-import recovery, No-upload check, CLI parity). After phase A the rows that phase B completes read `pending phase B`; phase B rewrites the whole report.
3. **WEB-007 golden checklist**: one line per item, ticked or marked FAIL.
4. **Netlify check**: the API result, or `Netlify check: manual (no token)`.
5. **Failures**: each failing item with its message, or `None.`

The report never contains the Netlify token or any secret.

### Where to paste it

Put the whole `report.md` into the release pull request description or the GitHub Release notes, or into a new release record for that release. Never edit older records: the existing ASSET-006 Part B Record and the WEB-007 [Production release record](../web/production-deployment.md#production-release-record) stay as history of the first gates.

## Netlify checks

### With `NETLIFY_AUTH_TOKEN` (optional)

When the variable is set, the **runner** (never the browser) makes read-only `GET` requests to the Netlify API for the site and for the deploy ID found in the page's build identity, and checks that:

- the deploy is `ready`;
- its commit equals the page's commit;
- for `prod`, it is the site's published production deploy;
- whether it has Functions (this app should have none).

It never calls a mutating endpoint and never prints the token. Local targets skip this check.

**Edge Functions stay a manual Netlify check, even with a token.** The runner does not look for them, and the report's Netlify line says `Edge Functions: not checked (confirm in the Netlify UI)`. Open the deploy in the Netlify UI and confirm none are listed (see below).

Use a personal access token (Netlify: User settings, Applications, Personal access tokens). Set it only for the current session:

```powershell
# PowerShell
$env:NETLIFY_AUTH_TOKEN = "<token>"
npm run gate -- --url=prod --phase=A
```

```bash
# bash
NETLIFY_AUTH_TOKEN="<token>" npm run gate -- --url=prod --phase=A
```

Do not commit the token or put it in a file in the repository.

### Without a token (manual)

The report says `Netlify check: manual (no token)`. In the Netlify UI for the site, confirm for Deploy A and Deploy B and note it next to the Record rows:

- the deploy is **Published** and its status is **ready**;
- the deploy's commit matches the commit in the report's Deploy A / Deploy B rows (the Netlify deploy ID is in the same row);
- no Functions or Edge Functions are listed for the deploy (Edge Functions need this manual check with or without a token).

## Remotion telemetry (production safety)

The suite only reads the static site and writes to its own profile under `.gate/`. Each browser render sends Remotion's licence telemetry (`register-usage-point`, about 0.2 kB, no user data), the same as a person doing the gate by hand: about 5 requests in a phase A run and about 2 in a phase B run. Do not run the suite against `prod` as a rehearsal; use `--url=local` or `--url=preview:<n>`.

## Troubleshooting

| Message or symptom | What to do |
| --- | --- |
| `Deploy B is not live yet: still <identity>` | Netlify has not published a new deploy at that URL. Wait until Deploy B is **Published**, then run phase B again. |
| `Phase B needs phase A's state` / `Phase A was run for <other url>` | Run phase A first, on this machine, for the same URL. Phase A recreates `.gate/<target>/`; do not run it again between A and B. |
| `Phase A did not pass (...); rerun phase A before phase B` | Phase A's state is incomplete or has a failing item, so phase B cannot build on it. Fix the cause and rerun phase A (with `--fresh` if it refuses). If Deploy B is already live, that rerun tests the Deploy B build, so a clean A to B comparison costs one more deploy (a Deploy C): merge another commit, run phase A against it, then run phase B once it is published. Avoid this by merging Deploy B only after the report reads `PHASE A PASSED (phase B pending)`. |
| `Phase A already passed for <url> ...` | Phase A refused to delete a passed phase A whose phase B has not completed. Run (or rerun) phase B. Pass `--fresh` only to throw the earlier state and profile away on purpose. |
| `--url is required` from PowerShell | `npm.ps1` dropped the `--` and npm did not export the flags. Run `npm.cmd run gate -- --url=... --phase=...` or `node scripts/gate.mjs --url=... --phase=...`. |
| Port 4190 is already in use (`--url=local`) | Another process holds the port, often a leftover `vite preview` or another gate run. Stop it and retry. |
| Chrome is not found | Install Google Chrome (the suite launches `channel: "chrome"`). Do not run `npx playwright install`. |
| CLI parity cannot find a browser | Point Remotion's CLI at Chrome with `TORA_REMOTION_BROWSER_EXECUTABLE`. PowerShell: `$env:TORA_REMOTION_BROWSER_EXECUTABLE = "C:\Program Files\Google\Chrome\Application\chrome.exe"`. bash: `export TORA_REMOTION_BROWSER_EXECUTABLE=/usr/bin/google-chrome`. |
| `Gate environment is not set` | Do not call `playwright test --config=playwright.gate.config.mjs` directly; use `npm run gate -- ...`. |
| Netlify check: fail | Read the check list in the report. `check NETLIFY_AUTH_TOKEN` means the token is wrong or lacks access. |
| Network guard violation | The report lists the request. Something sent data the suite forbids: treat it as a release blocker and investigate before shipping. |
| Cancel Render item says `cleanup-blocked` | Known app behaviour after cancelling a render; the item still passes as long as authoring unlocks and nothing downloads. |
