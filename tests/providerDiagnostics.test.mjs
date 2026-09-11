import assert from "node:assert/strict";
import test from "node:test";

test("provider diagnostics preserve the provider, exit code, and working directory", async () => {
  const { providerLaunchFailureMessage } = await import("../src/lib/providerDiagnostics.ts");

  assert.equal(
    providerLaunchFailureMessage({
      providerName: "Claude Code",
      cwd: "D:/Taxzy_CLI",
      exitCode: 1,
    }),
    'Claude Code exited during startup (exit code 1) in "D:/Taxzy_CLI". Open the terminal output, then verify the CLI is authenticated and available in this folder.',
  );
});

test("provider diagnostics keep a real backend error intact", async () => {
  const { providerLaunchFailureMessage } = await import("../src/lib/providerDiagnostics.ts");

  assert.equal(
    providerLaunchFailureMessage({
      providerName: "Codex",
      cwd: "D:/Taxzy_CLI",
      reason: "Executable was not found",
    }),
    "Codex: Executable was not found",
  );
});
