import { afterEach, describe, expect, it } from "vitest";

import { decodeCaller, encodeCaller, startToolHost, type ToolCaller, type ToolHost } from "./toolHost.js";

const hosts: ToolHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

async function host() {
  const built: Array<{ name: string; caller: ToolCaller }> = [];
  const started = await startToolHost({
    controlFile: "unused",
    token: "secret",
    createServer: (name, caller) => {
      built.push({ name, caller });
      return {
        handleMessage: async (message) => {
          const request = message as { id?: number; method?: string };
          if (request.id === undefined) return undefined;
          return { jsonrpc: "2.0", id: request.id, result: { server: name, caller, method: request.method } };
        },
      };
    },
  });
  hosts.push(started);
  const post = (path: string, body: unknown, token = "secret") =>
    fetch(`http://127.0.0.1:${started.port}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { built, post, port: started.port };
}

describe("tool host", () => {
  it("round-trips the caller through the URL", () => {
    const caller = { worktreeId: "w-1", cwd: "C:\\Users\\me\\repo with spaces\\ünï" };
    expect(decodeCaller(encodeCaller(caller))).toEqual(caller);
    expect(decodeCaller(encodeCaller({}))).toEqual({});
    expect(decodeCaller("not base64 json")).toBeUndefined();
  });

  it("answers each server for the caller named in the URL, one server per caller", async () => {
    const { built, post } = await host();
    const key = encodeCaller({ worktreeId: "w-1", cwd: "C:\\repo" });
    const first = await post(`/mcp/zli-browser/${key}`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      id: 1,
      result: { server: "zli-browser", caller: { worktreeId: "w-1", cwd: "C:\\repo" }, method: "tools/list" },
    });
    await post(`/mcp/zli-browser/${key}`, { jsonrpc: "2.0", id: 2, method: "tools/call" });
    await post(`/mcp/zli/${key}`, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(built.map((entry) => entry.name)).toEqual(["zli-browser", "zli"]);
  });

  it("accepts notifications with 202 and answers batches as a list", async () => {
    const { post } = await host();
    const key = encodeCaller({ worktreeId: "w-2" });
    const note = await post(`/mcp/zli-mobile/${key}`, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    const batch = await post(`/mcp/zli-mobile/${key}`, [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 7, method: "ping" },
    ]);
    expect(await batch.json()).toMatchObject([{ id: 7 }]);
  });

  it("refuses a wrong token, an unknown server, and a GET stream", async () => {
    const { post, port } = await host();
    const key = encodeCaller({ worktreeId: "w-3" });
    expect((await post(`/mcp/zli/${key}`, {}, "wrong")).status).toBe(401);
    expect((await post(`/mcp/other/${key}`, {})).status).toBe(404);
    const stream = await fetch(`http://127.0.0.1:${port}/mcp/zli/${key}`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(stream.status).toBe(405);
  });
});
