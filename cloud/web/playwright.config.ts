import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  timeout: 45_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4789",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun e2e/server.ts",
    url: "http://127.0.0.1:4789/healthz",
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
