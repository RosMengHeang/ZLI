import assert from "node:assert/strict";
import test from "node:test";

test("cli maps agent send arguments to a versioned control request", async () => {
  const { parseCli } = await import("../src/control/cli.ts");
  const parsed = parseCli(["agent", "send", "agent-1", "Run", "tests"]);
  assert.equal(parsed.json, false);
  assert.equal(parsed.request.method, "agent.send");
  assert.equal(parsed.request.params.agentId, "agent-1");
  assert.equal(parsed.request.params.body, "Run tests");
  assert.equal(parsed.request.protocolVersion, 1);
});

test("cli requires project scope when spawning an agent", async () => {
  const { parseCli } = await import("../src/control/cli.ts");
  const parsed = parseCli(["agent", "spawn", "D:/repo", "codex", "Review", "tests"]);

  assert.equal(parsed.request.method, "agent.spawn");
  assert.deepEqual(parsed.request.params, {
    projectId: "D:/repo",
    providerId: "codex",
    task: "Review tests",
  });
  assert.throws(() => parseCli(["agent", "spawn", "D:/repo"]), /provider/i);
});

test("cli supports the documented managed-agent spawn flags", async () => {
  const { parseCli } = await import("../src/control/cli.ts");
  const parsed = parseCli([
    "agent", "spawn", "--provider", "codex", "--task", "Review the API", "--name", "API reviewer",
  ], { projectId: "D:/repo" });

  assert.deepEqual(parsed.request.params, {
    projectId: "D:/repo",
    providerId: "codex",
    task: "Review the API",
    name: "API reviewer",
  });
});

test("cli supports JSON mode and rejects ambiguous or incomplete commands", async () => {
  const { parseCli } = await import("../src/control/cli.ts");
  const parsed = parseCli(["--json", "session", "resume", "session-1"]);
  assert.equal(parsed.json, true);
  assert.equal(parsed.request.method, "session.resume");
  assert.equal(parsed.request.params.sessionId, "session-1");

  assert.throws(() => parseCli(["agent", "send", "agent-1"]), /message/i);
  assert.throws(() => parseCli(["destroy", "everything"]), /Unknown command/i);
});

test("cli exposes an explicit session reconciliation report", async () => {
  const { parseCli } = await import("../src/control/cli.ts");
  const parsed = parseCli(["session", "reconcile"]);
  assert.equal(parsed.request.method, "session.reconcile");
  assert.deepEqual(parsed.request.params, {});
  assert.equal(parseCli(["doctor"]).request.method, "session.reconcile");
});

test("attention acknowledgement is project scoped", async () => {
  const { parseCli } = await import("../src/control/cli.ts");

  assert.deepEqual(
    parseCli(["attention", "ack", "agent-1", "--project", "D:/repo"]).request.params,
    { projectId: "D:/repo", agentId: "agent-1" },
  );
  assert.deepEqual(
    parseCli(["attention", "ack", "agent-1"], { projectId: "D:/repo" }).request.params,
    { projectId: "D:/repo", agentId: "agent-1" },
  );
  assert.throws(() => parseCli(["attention", "ack", "agent-1"]), /project/i);
});

test("browser commands expose the complete scoped automation surface", async () => {
  const { parseCli } = await import("../src/control/cli.ts");
  assert.deepEqual(parseCli(["browser", "open", "https://example.com"], { projectId: "project-1" }).request.params, {
    projectId: "project-1",
    url: "https://example.com",
  });
  assert.deepEqual(parseCli(["browser", "snapshot", "surface-1", "--selector", "main", "--depth", "8"]).request.params, {
    surfaceId: "surface-1",
    selector: "main",
    maxDepth: 8,
  });
  assert.deepEqual(parseCli(["browser", "fill", "surface-1", "#name", "Ada", "Lovelace"]).request.params, {
    surfaceId: "surface-1",
    selector: "#name",
    text: "Ada Lovelace",
  });
  assert.deepEqual(parseCli(["browser", "wait", "surface-1", "--selector", "#ready", "--state", "visible", "--timeout", "5000"]).request.params, {
    surfaceId: "surface-1",
    condition: { kind: "selector", selector: "#ready", state: "visible" },
    timeoutMs: 5000,
  });
  assert.equal(parseCli(["browser", "screenshot", "surface-1"]).request.method, "browser.screenshot");
});

test("TaxChat send keeps project scope and explicit recipients out of the message body", async () => {
  const { parseCli } = await import("../src/control/cli.ts");
  const parsed = parseCli([
    "taxchat", "send", "Review", "the", "release", "--project", "D:/repo", "--to", "agent-1", "--to", "agent-2",
  ]);

  assert.deepEqual(parsed.request.params, {
    projectId: "D:/repo",
    body: "Review the release",
    recipientIds: ["agent-1", "agent-2"],
  });
  assert.throws(() => parseCli(["taxchat", "send", "Hello"]), /project/i);
  assert.equal(
    parseCli(["taxchat", "send", "Hello"], { projectId: "D:/repo" }).request.params.projectId,
    "D:/repo",
  );
});

test("control client sends the same strict protocol through Tauri", async () => {
  const { createControlClient } = await import("../src/control/client.ts");
  let sent;
  const client = createControlClient(async (_command, args) => {
    sent = args.request;
    return { id: sent.id, protocolVersion: 1, ok: true, result: { agents: [] } };
  });
  const result = await client.request("agent.list", { projectId: "D:/project" }, { id: "req-1" });
  assert.deepEqual(result, { agents: [] });
  assert.equal(sent.method, "agent.list");
  assert.equal(sent.timeoutMs, 30_000);
});
