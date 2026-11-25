import { defineConfig } from "@playwright/test";

process.env.ZLI_RUN_E2E ??= "1";

export default defineConfig({
  testDir: ".",
  testMatch:
    process.env.ZLI_BENCH_RELIABILITY === "1"
      ? "reliability.bench.ts"
      : process.env.ZLI_BENCH_LATENCY === "1"
        ? "latency.bench.ts"
        : "ademark.bench.ts",
  globalSetup: "../tests/e2e/global-setup.ts",
  timeout: 60 * 60_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
