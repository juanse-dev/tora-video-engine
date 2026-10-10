import {defineConfig} from "@playwright/test";

// ASSET-006 A1. Deliberately outside tests/browser/ and without a shared
// webServer: the spec starts its own vite preview servers (build A, then build
// B on the same port) and launches its own system-Chrome persistent contexts.
export default defineConfig({
  testDir: "tests/persistence",
  timeout: 420_000,
  workers: 1,
  fullyParallel: false,
});
