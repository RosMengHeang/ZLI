import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Each test launches its own app with its own database and profile, so two run at once. GitHub's macOS
  // runners have 3 cores, and more than two Electron apps at a time there slows every test down.
  workers: 2,
  reporter: [["list"]],
  use: {
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
