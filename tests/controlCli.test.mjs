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
