import {defineConfig} from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  // The golden plus the specs whose render paths bundled Chromium cannot run.
  testMatch: [
    "browser-render-golden.spec.mjs",
    "render-caption-geometry.spec.mjs",
    "local-asset-preview.spec.mjs",
    "local-asset-render-race.spec.mjs",
    "my-assets-render.spec.mjs",
    "render-cancel-cleanup.spec.mjs",
    "my-audio-m4a.spec.mjs",
    "audio-rendering.spec.mjs",
  ],
  timeout: 240_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: "chrome",
    headless: true,
  },
  webServer: {
    command:
      "npm run web:preview -- --host 127.0.0.1 --port 4173",
    port: 4173,
    reuseExistingServer: false,
  },
});
