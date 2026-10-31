import { defineConfig } from "vitest/config";

// Windows CI runners start git several times slower than Linux or macOS, so the server tests that build
// real repositories can pass 5 seconds there. A timeout mid-git also leaves the folder locked (EBUSY).
const slowGit = process.platform === "win32";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**"],
    ...(slowGit ? { testTimeout: 30_000, hookTimeout: 30_000 } : {}),
  },
});
