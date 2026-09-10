import assert from "node:assert/strict";
import test from "node:test";

test("browser protocol rejects interaction commands without a surface", async () => {
  const { decodeBrowserCommand } = await import("../src/lib/browser/browserProtocol.ts");

  assert.throws(
    () => decodeBrowserCommand({ kind: "click", selector: "#submit" }),
    (error) => error.code === "BROWSER_INVALID_COMMAND" && /surfaceId/.test(error.message),
  );
});

test("browser output limits are explicit", async () => {
  const { BROWSER_LIMITS } = await import("../src/lib/browser/browserProtocol.ts");

  assert.equal(BROWSER_LIMITS.maxSnapshotCharacters, 100_000);
  assert.equal(BROWSER_LIMITS.maxScriptCharacters, 20_000);
  assert.equal(BROWSER_LIMITS.maxSnapshotDepth, 32);
  assert.equal(BROWSER_LIMITS.maxCommandTimeoutMs, 120_000);
});

test("browser protocol accepts only safe first-release URLs", async () => {
  const { decodeBrowserCommand } = await import("../src/lib/browser/browserProtocol.ts");

  assert.deepEqual(decodeBrowserCommand({ kind: "open", url: "https://example.com/path" }), {
    kind: "open",
    url: "https://example.com/path",
  });
  assert.deepEqual(decodeBrowserCommand({ kind: "open", url: "about:blank" }), {
    kind: "open",
    url: "about:blank",
  });
  for (const url of [
    "file:///C:/secret.txt",
    "javascript:alert(1)",
    "data:text/html,secret",
    "about:config",
    "https://user:password@example.com",
    "https://:",
  ]) {
    assert.throws(
      () => decodeBrowserCommand({ kind: "open", url }),
      (error) => error.code === "BROWSER_INVALID_COMMAND" && /url/i.test(error.message),
    );
  }
});

test("browser protocol validates selectors, keys, scripts, snapshot depth, and wait timeout", async () => {
  const { BROWSER_LIMITS, decodeBrowserCommand } = await import("../src/lib/browser/browserProtocol.ts");
  const invalid = [
    { kind: "click", surfaceId: "surface-1", selector: "  " },
    { kind: "press", surfaceId: "surface-1", key: "LaunchCalculator" },
    { kind: "eval", surfaceId: "surface-1", script: "x".repeat(BROWSER_LIMITS.maxScriptCharacters + 1) },
    { kind: "snapshot", surfaceId: "surface-1", maxDepth: BROWSER_LIMITS.maxSnapshotDepth + 1 },
    {
      kind: "wait",
      surfaceId: "surface-1",
      condition: { kind: "selector", selector: "#ready", state: "visible" },
      timeoutMs: BROWSER_LIMITS.maxCommandTimeoutMs + 1,
    },
  ];

  for (const command of invalid) {
    assert.throws(
      () => decodeBrowserCommand(command),
      (error) => error.code === "BROWSER_INVALID_COMMAND",
    );
  }

  assert.deepEqual(
    decodeBrowserCommand({ kind: "press", surfaceId: "surface-1", key: "Enter" }),
    { kind: "press", surfaceId: "surface-1", key: "Enter" },
  );
});

test("browser protocol decodes every bounded result variant", async () => {
  const { decodeBrowserResult } = await import("../src/lib/browser/browserProtocol.ts");
  const results = [
    { kind: "surface", surfaceId: "surface-1", projectId: "project-1", agentId: null, url: "about:blank", profileId: "profile-1" },
    { kind: "navigation", surfaceId: "surface-1", url: "https://example.com/", phase: "finished" },
    { kind: "snapshot", surfaceId: "surface-1", content: "<main />", truncated: false },
    { kind: "consoleEntries", surfaceId: "surface-1", entries: [], truncated: false },
    { kind: "pageErrors", surfaceId: "surface-1", errors: [], truncated: false },
    { kind: "screenshot", surfaceId: "surface-1", dataUrl: "data:image/png;base64,AA==", width: 1, height: 1 },
  ];

  for (const result of results) assert.deepEqual(decodeBrowserResult(result), result);
  assert.throws(
    () => decodeBrowserResult({ kind: "snapshot", surfaceId: "surface-1", content: 42, truncated: false }),
    (error) => error.code === "BROWSER_INVALID_COMMAND",
  );
  assert.deepEqual(
    decodeBrowserResult({ kind: "snapshot", surfaceId: "surface-1", content: "", truncated: false }),
    { kind: "snapshot", surfaceId: "surface-1", content: "", truncated: false },
  );
});
