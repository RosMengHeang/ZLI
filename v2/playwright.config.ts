import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Each test launches its own app with its own database and profile, so two run at once. GitHub's macOS
  // runners have 3 cores, and more than two Electron apps at a time there slows every test down.
  workers: 2,
  // A shared CI runner sometimes stalls long enough that an app's first window or a shell's prompt misses its
  // wait. A test that fails is run once more there: one that passes then is reported as flaky in the log, while
  // a real failure still fails both times. Local runs never retry.
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
