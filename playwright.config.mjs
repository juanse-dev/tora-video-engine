import {defineConfig} from "@playwright/test";

// The focus-restore spec is the one place where browser engines are known to
// differ (Safari and Firefox do not focus a button on click and restore focus
// differently), so it also runs in Firefox and WebKit. Everything else stays
// on the bundled Chromium only, which keeps CI time small.
const CROSS_BROWSER_SPECS = ["my-assets-focus.spec.mjs"];

export default defineConfig({
  testDir: "tests/browser",
  // These need system Chrome (H.264 encode); see
  // playwright.browser-render.config.mjs. render-cancel-cleanup and
  // render-caption-geometry must fail, not skip, without render support, so
  // they never run under bundled Chromium.
  testIgnore: [
    "browser-render-golden.spec.mjs",
    "render-cancel-cleanup.spec.mjs",
    "render-caption-geometry.spec.mjs",
    "my-audio-m4a.spec.mjs",
  ],
  timeout: 20_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
  },
  projects: [
    {name: "chromium", use: {browserName: "chromium"}},
    {
      name: "firefox",
      testMatch: CROSS_BROWSER_SPECS,
      use: {browserName: "firefox"},
    },
    {
      name: "webkit",
      testMatch: CROSS_BROWSER_SPECS,
      use: {browserName: "webkit"},
    },
  ],
  webServer: {
    command:
      "npm run web:preview -- --host 127.0.0.1 --port 4173",
    port: 4173,
    reuseExistingServer: false,
  },
});
