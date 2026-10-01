import {defineConfig} from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  timeout: 20_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: process.env.TORA_PLAYWRIGHT_CHANNEL || undefined,
    headless: true,
  },
  webServer: {
    command:
      "npm run web:preview -- --host 127.0.0.1 --port 4173",
    port: 4173,
    reuseExistingServer: false,
  },
});
