import { defineConfig } from "@playwright/test";

// The specs skip unless ZLI_RUN_E2E is 1, so other runners that collect test files never start Electron.
// Running Playwright itself means the Electron tests are wanted. Set ZLI_RUN_E2E=0 to skip them anyway.
process.env.ZLI_RUN_E2E ??= "1";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Each test launches its own app with its own database and profile, so two run at once. GitHub's macOS
  // runners have 3 cores: with two apps at a time there, the last specs of the 70-odd ran out of time waiting for
  // a window, so macOS CI runs one at a time.
  workers: process.env.CI && process.platform === "darwin" ? 1 : 2,
  reporter: [["list"]],
  use: {
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
