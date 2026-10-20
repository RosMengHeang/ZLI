import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { ZliBrowserUnavailableError } from "./client.js";
import { createMcpServer, MCP_TOOLS, serveMcpOverStdio } from "./mcp.js";

describe("zli-browser MCP server", () => {
  it("negotiates a supported protocol version and lists every browser tool", async () => {
    const server = createMcpServer(async () => ({}));
    const init = (await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {} },
    })) as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: unknown } };
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.serverInfo.name).toBe("zli-browser");
    expect(init.result.capabilities).toEqual({ tools: { listChanged: false } });

    const future = (await server.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2099-01-01" },
    })) as { result: { protocolVersion: string } };
    expect(future.result.protocolVersion).toBe("2025-06-18");

    const list = (await server.handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" })) as {
      result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> };
    };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(MCP_TOOLS.map((tool) => tool.name));
    expect(list.result.tools.map((tool) => tool.name)).toContain("browser_open");
    for (const tool of list.result.tools) {
      expect(tool.inputSchema.properties).toHaveProperty("cwd");
      expect(tool.inputSchema.properties).toHaveProperty("tabId");
    }
  });

  it("forwards tool arguments to the control action and maps tabId", async () => {
    const calls: Array<{ action: string; input: unknown }> = [];
    const server = createMcpServer(async (action, input) => {
      calls.push({ action, input });
      return { clicked: true };
    });
    const response = (await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_click", arguments: { selector: "#save", tabId: "tab-1", cwd: "/repo", ignored: 1 } },
    })) as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } };
    expect(calls).toEqual([{ action: "click", input: { selector: "#save", cwd: "/repo", browserTabId: "tab-1" } }]);
    expect(JSON.parse(response.result.content[0]?.text ?? "")).toEqual({ clicked: true });
    expect(response.result.isError).toBeUndefined();
  });

  it("returns screenshots as image content", async () => {
    const server = createMcpServer(async () => ({
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
      url: "http://localhost:3000/",
      width: 10,
      height: 20,
    }));
    const response = (await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_screenshot", arguments: {} },
    })) as { result: { content: unknown[] } };
    expect(response.result.content).toEqual([
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      { type: "text", text: "Screenshot of http://localhost:3000/, 10x20 px." },
    ]);
  });

  it("reports failures as tool errors, including ZLI not running", async () => {
    const notRunning = createMcpServer(async () => {
      throw new ZliBrowserUnavailableError();
    });
    expect(
      await notRunning.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "browser_tabs", arguments: {} },
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "ZLI is not running, so its browser is unavailable." }],
        isError: true,
      },
    });

    const loadFailure = createMcpServer(async () => ({ tab: { loadError: "Could not load http://localhost:9/" } }));
    const failed = (await loadFailure.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "browser_open", arguments: { url: "localhost:9" } },
    })) as { result: { isError?: boolean } };
    expect(failed.result.isError).toBe(true);
  });

  it("answers protocol errors and ignores notifications", async () => {
    const server = createMcpServer(async () => ({}));
    expect(await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    expect(await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "resources/list" })).toMatchObject({
      error: { code: -32601 },
    });
    expect(
      await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_fly" } }),
    ).toMatchObject({ error: { code: -32602 } });
    expect(await server.handleMessage({ jsonrpc: "2.0", id: 3, method: "ping" })).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: {},
    });
  });

  it("serves newline-delimited JSON-RPC over stdio", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(String(chunk)));
    const serving = serveMcpOverStdio(
      createMcpServer(async () => ({})),
      input,
      output,
    );
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    input.write("not json\n");
    input.end();
    await serving;
    const lines = chunks
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toContainEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(lines).toContainEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
  });
});
