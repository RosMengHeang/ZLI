import { describe, expect, it } from "vitest";

import { parseZliArgs, runZli, ZliUsageError } from "./cli.js";
import { AGENT_MCP_TOOLS, createAgentMcpServer } from "./mcp.js";

describe("zli command", () => {
  it("maps commands to agent actions", () => {
    expect(parseZliArgs(["agents"])).toEqual({ kind: "call", action: "agentlist", input: {} });
    expect(parseZliArgs(["read", "abcd1234", "--limit", "5"])).toEqual({
      kind: "call",
      action: "agentread",
      input: { agent: "abcd1234", limit: 5 },
    });
    expect(parseZliArgs(["send", "abcd1234", "please", "rebase"])).toEqual({
      kind: "call",
      action: "agentsend",
      input: { agent: "abcd1234", text: "please rebase" },
    });
    expect(
      parseZliArgs(["start", "claude-code", "Write", "docs", "--terminal", "--same-worktree", "--model=opus"]),
    ).toEqual({
      kind: "call",
      action: "agentstart",
      input: { provider: "claude-code", prompt: "Write docs", mode: "terminal", worktree: "same", model: "opus" },
    });
    expect(parseZliArgs(["connect", "github", "to", "open", "a", "PR"])).toEqual({
      kind: "call",
      action: "agentconnect",
      input: { service: "github", reason: "to open a PR" },
    });
    expect(parseZliArgs(["agents", "--all-projects"])).toEqual({
      kind: "call",
      action: "agentlist",
      input: { allProjects: true },
    });
    expect(parseZliArgs(["send", "bob", "--project", "api", "check", "the", "contract"])).toEqual({
      kind: "call",
      action: "agentsend",
      input: { agent: "bob", project: "api", text: "check the contract" },
    });
    expect(parseZliArgs(["send", "lead", "done", "--as", "helper"])).toEqual({
      kind: "call",
      action: "agentsend",
      input: { agent: "lead", text: "done", as: "helper" },
    });
    expect(parseZliArgs(["start", "codex", "Check", "links", "--as=helper"])).toEqual({
      kind: "call",
      action: "agentstart",
      input: { provider: "codex", prompt: "Check links", as: "helper" },
    });
    expect(parseZliArgs(["read", "api/bob"])).toEqual({
      kind: "call",
      action: "agentread",
      input: { agent: "api/bob" },
    });
    expect(parseZliArgs(["start", "codex", "Review", "auth", "--name", "John"])).toEqual({
      kind: "call",
      action: "agentstart",
      input: { provider: "codex", prompt: "Review auth", name: "John" },
    });
    expect(parseZliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseZliArgs(["mcp"])).toEqual({ kind: "mcp" });
  });

  it("explains bad usage", () => {
    expect(() => parseZliArgs(["send", "abcd1234"])).toThrow(new ZliUsageError("send needs a message."));
    expect(() => parseZliArgs(["read", "x", "--limit", "0"])).toThrow("--limit must be a whole number above 0.");
    expect(() => parseZliArgs(["agents", "--tab", "1"])).toThrow("Unknown option --tab.");
    expect(() => parseZliArgs(["connect"])).toThrow("connect needs a service such as github or linear.");
  });

  it("prints terminal output as text and other results as JSON", async () => {
    const printed: string[] = [];
    const io = { stdout: (text: string) => printed.push(text), stderr: (text: string) => printed.push(`err:${text}`) };
    await runZli({ kind: "call", action: "agentread", input: {} }, async () => ({ output: "$ npm test" }), io);
    await runZli({ kind: "call", action: "agentlist", input: {} }, async () => ({ agents: [] }), io);
    await runZli(
      { kind: "call", action: "agentconnect", input: {} },
      async () => ({ status: "asked", message: "Asked the person to connect GitHub in ZLI." }),
      io,
    );
    const code = await runZli(
      { kind: "call", action: "agentsend", input: {} },
      async () => {
        throw new Error("That agent is you.");
      },
      io,
    );
    expect(printed).toEqual([
      "$ npm test\n",
      '{\n  "agents": []\n}\n',
      "Asked the person to connect GitHub in ZLI.\n",
      "err:That agent is you.\n",
    ]);
    expect(code).toBe(1);
  });
});

describe("zli MCP server", () => {
  const listNames = async (access: string) => {
    const server = createAgentMcpServer(async (action) => (action === "agentaccess" ? { access } : null));
    const response = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: { tools: Array<{ name: string }> };
    };
    return response.result.tools.map((tool) => tool.name);
  };

  it("lists only the tools Settings allow", async () => {
    expect(await listNames("full")).toEqual([
      "list_agents",
      "read_agent",
      "message_agent",
      "start_agent",
      "connect_service",
    ]);
    expect(await listNames("read")).toEqual(["list_agents", "read_agent", "connect_service"]);
    expect(await listNames("off")).toEqual([]);
  });

  it("lists every tool when ZLI cannot be reached, so calls explain the problem", async () => {
    const server = createAgentMcpServer(async () => {
      throw new Error("ZLI is not running, so other agents cannot be reached.");
    });
    const listed = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: { tools: unknown[] };
    };
    expect(listed.result.tools).toHaveLength(AGENT_MCP_TOOLS.length);
    const called = (await server.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_agents", arguments: {} },
    })) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(called.result.isError).toBe(true);
    expect(called.result.content[0]?.text).toBe("ZLI is not running, so other agents cannot be reached.");
  });

  it("passes declared arguments and cwd to the action", async () => {
    const calls: unknown[] = [];
    const server = createAgentMcpServer(async (action, input) => {
      calls.push([action, input]);
      return { delivered: true };
    });
    await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "message_agent", arguments: { agent: "abcd", text: "hi", cwd: "/work", extra: 1 } },
    });
    expect(calls).toEqual([["agentsend", { agent: "abcd", text: "hi", cwd: "/work" }]]);
  });
});
