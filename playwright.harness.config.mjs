import {defineConfig} from "@playwright/test";

// Harness specs exercise the real IndexedDB adapter in a browser, against the
// vite dev server (the harness page is not part of the production build).
export default defineConfig({
  testDir: "tests/harness",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4174",
    headless: true,
  },
  webServer: {
    command: "npm run web:dev -- --host 127.0.0.1 --port 4174 --strictPort",
    port: 4174,
    reuseExistingServer: false,
  },
});
