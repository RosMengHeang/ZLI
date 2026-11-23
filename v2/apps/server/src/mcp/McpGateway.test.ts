import type { McpServerConfig } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { SIGN_IN_CODE } from "./bridge/mcpBridge.js";
import { type GatewayServer, McpGateway, queryWords, scoreTool } from "./McpGateway.js";
import type { ProbeConnect } from "./McpProbe.js";

type FakeTool = { name: string; description?: string; inputSchema?: unknown };

/** A pretend MCP server: answers initialize, lists `tools`, and echoes calls. Counts how often it was started. */
function fakeServer(
  name: string,
  tools: FakeTool[],
  options: { signIn?: boolean; started?: { count: number }; calls?: unknown[] } = {},
): GatewayServer & { notify(message: unknown): void } {
  let deliver: ((message: unknown) => void) | undefined;
  let current = tools;
  const connect: ProbeConnect = (handlers) => {
    if (options.started) options.started.count += 1;
    deliver = handlers.onMessage;
    return {
      send(message) {
        const request = message as { id?: number; method: string; params?: Record<string, unknown> };
        if (request.id === undefined) return;
        const reply = (result: unknown) =>
          queueMicrotask(() => handlers.onMessage({ jsonrpc: "2.0", id: request.id, result }));
        const fail = (code: number, text: string) =>
          queueMicrotask(() => handlers.onMessage({ jsonrpc: "2.0", id: request.id, error: { code, message: text } }));
        if (request.method === "initialize") {
          if (options.signIn) fail(SIGN_IN_CODE, "Sign in first.");
          else reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
        } else if (request.method === "tools/list") {
          reply({ tools: current });
        } else if (request.method === "tools/call") {
          options.calls?.push(request.params);
          reply({ content: [{ type: "text", text: `ran ${String(request.params?.name)}` }] });
        }
      },
      close: async () => undefined,
    };
  };
  return {
    config: { name, transport: "http", url: `https://${name}.example/mcp`, enabled: true } as McpServerConfig,
    hiddenTools: [],
    connect,
    notify(message) {
      current = [...current, { name: "late_tool", description: "Added later." }];
      deliver?.(message);
    },
  };
}

const vercel = () =>
  fakeServer("vercel", [
    {
      name: "list_deployments",
      description: "List deployments of a Vercel project.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" } } },
    },
    { name: "get_build_logs", description: "Read the build logs of a deployment." },
  ]);
const linear = () =>
  fakeServer("linear", [
    { name: "createIssue", description: "Create a Linear issue." },
    { name: "list_teams", description: "List teams." },
  ]);

let gateway: McpGateway;
afterEach(async () => {
  await gateway?.close();
});

describe("McpGateway", () => {
  it("finds tools by what they do across services, with what is needed to call them", async () => {
    gateway = new McpGateway();
    const result = await gateway.find([vercel(), linear()], "list vercel deployments");
    expect(result.tools[0]).toMatchObject({
      server: "vercel",
      name: "list_deployments",
      inputSchema: { type: "object", properties: { projectId: { type: "string" } } },
    });
    expect(result.services).toEqual([
      { name: "vercel", status: "ready", toolCount: 2 },
      { name: "linear", status: "ready", toolCount: 2 },
    ]);
    const issue = await gateway.find([vercel(), linear()], "create issue");
    expect(issue.tools[0]?.name).toBe("createIssue");
  });

  it("lists the services for an empty query and says when one needs a sign-in", async () => {
    gateway = new McpGateway();
    const result = await gateway.find([vercel(), fakeServer("notion", [], { signIn: true })], "");
    expect(result.tools).toEqual([]);
    expect(result.services[1]).toMatchObject({ name: "notion", status: "needs_sign_in" });
    expect(result.hint).toContain("connect_service");
  });

  it("calls a tool through one shared session and passes its result through", async () => {
    gateway = new McpGateway();
    const started = { count: 0 };
    const calls: unknown[] = [];
    const server = fakeServer("vercel", [{ name: "deploy" }], { started, calls });
    await gateway.find([server], "deploy");
    const result = await gateway.call([server], "Vercel", "deploy", { project: "web" });
    expect(result).toEqual({ content: [{ type: "text", text: "ran deploy" }] });
    expect(calls).toEqual([{ name: "deploy", arguments: { project: "web" } }]);
    expect(started.count).toBe(1);
  });

  it("refuses tools the person turned off and services that are not connected", async () => {
    gateway = new McpGateway();
    const server = { ...vercel(), hiddenTools: ["get_build_logs"] };
    const found = await gateway.find([server], "build logs");
    expect(found.tools.map((tool) => tool.name)).not.toContain("get_build_logs");
    expect((await gateway.call([server], "vercel", "get_build_logs", {})).isError).toBe(true);
    const missing = await gateway.call([server], "github", "anything", {});
    expect(missing.content[0]).toMatchObject({ text: expect.stringContaining("Connected: vercel") });
  });

  it("lists the tools again after the server says they changed", async () => {
    gateway = new McpGateway();
    const server = vercel();
    expect((await gateway.find([server], "late")).tools).toEqual([]);
    server.notify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    expect((await gateway.find([server], "late")).tools.map((tool) => tool.name)).toEqual(["late_tool"]);
  });
});

describe("tool search scoring", () => {
  it("ranks a tool's own name over its service and its description", () => {
    const words = queryWords("deploy to the vercel");
    expect(words).toEqual(["deploy", "vercel"]);
    const named = scoreTool({ server: "vercel", name: "deploy_project" }, words);
    const described = scoreTool({ server: "netlify", name: "create_site", description: "Deploy a site." }, words);
    expect(named).toBeGreaterThan(described);
    expect(scoreTool({ server: "linear", name: "list_teams" }, words)).toBe(0);
  });
});
