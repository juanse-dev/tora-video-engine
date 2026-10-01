import {defineConfig} from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  testIgnore: "browser-render-golden.spec.mjs",
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
