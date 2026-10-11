import {defineConfig} from "@playwright/test";

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
  ],
  timeout: 20_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
  },
  webServer: {
    command:
      "npm run web:preview -- --host 127.0.0.1 --port 4173",
    port: 4173,
    reuseExistingServer: false,
  },
});
