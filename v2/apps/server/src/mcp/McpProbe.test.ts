import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runStdioRelay } from "./bridge/stdioRelay.js";
import { probeMcpServer } from "./McpProbe.js";

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A small MCP server: five tools, two per page. Writes its pid so the test can check it was stopped. */
const FAKE_SERVER = `
const fs = require("node:fs");
const readline = require("node:readline");
if (process.env.PID_FILE) fs.writeFileSync(process.env.PID_FILE, String(process.pid));
if (process.env.MODE === "crash") { process.stderr.write("starting\\nboom: missing API key\\n"); process.exit(3); }
const tools = Array.from({ length: 5 }, (_, i) => ({ name: "tool" + i, description: "Tool " + i }));
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (process.env.MODE === "silent") return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
  } else if (message.method === "tools/list") {
    const start = Number((message.params && message.params.cursor) || 0);
    const next = start + 2 < tools.length ? { nextCursor: String(start + 2) } : {};
    reply(message.id, { tools: tools.slice(start, start + 2), ...next });
  } else if (message.method === "tools/call") {
    reply(message.id, { content: [{ type: "text", text: "called " + message.params.name }] });
  }
});
`;

async function fakeServer(env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "zli-probe-"));
  temps.push(dir);
  const script = join(dir, "server.cjs");
  await writeFile(script, FAKE_SERVER, "utf8");
  const pidFile = join(dir, "pid");
  return {
    pidFile,
    server: {
      name: "fake",
      enabled: true,
      command: process.execPath,
      args: [script],
      env: { PID_FILE: pidFile, ...env },
      disabledTools: ["tool1"],
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("probeMcpServer", () => {
  it("lists every tool of a local server across pages, turned-off ones too, then stops it", async () => {
    const { server, pidFile } = await fakeServer();
    const outcome = await probeMcpServer(server);
    expect(outcome).toEqual({
      ok: true,
      tools: [0, 1, 2, 3, 4].map((index) => ({ name: `tool${index}`, description: `Tool ${index}` })),
    });
    const pid = Number(await readFile(pidFile, "utf8"));
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it("explains a command that is not installed", async () => {
    const outcome = await probeMcpServer({
      name: "missing",
      enabled: true,
      command: "zli-no-such-command",
      args: [],
      env: {},
    });
    expect(outcome).toEqual({
      ok: false,
      tools: [],
      problem:
        "ZLI could not start zli-no-such-command. Check that zli-no-such-command is installed and on your PATH, then try again.",
    });
  });

  it("passes on the last thing a crashing server printed", async () => {
    const { server } = await fakeServer({ MODE: "crash" });
    expect(await probeMcpServer(server)).toEqual({
      ok: false,
      tools: [],
      problem: "fake stopped before it answered: boom: missing API key.",
    });
  });

  it("gives up on a server that never answers and stops it", async () => {
    const { server, pidFile } = await fakeServer({ MODE: "silent" });
    const outcome = await probeMcpServer(server, { timeoutMs: 1_000 });
    expect(outcome).toEqual({ ok: false, tools: [], problem: "fake did not answer within 1 second." });
    const pid = Number(await readFile(pidFile, "utf8"));
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it("reaches remote servers through the bridge and asks for a sign-in when they want one", async () => {
    const remote = {
      name: "Linear",
      enabled: true,
      transport: "http" as const,
      url: "https://mcp.example.com/mcp",
      headers: { "X-Team": "a" },
      oauth: true,
    };
    const seenHeaders: Array<string | null> = [];
    const fetchTools = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response(null, { status: init?.method === "DELETE" ? 200 : 405 });
      const headers = new Headers(init.headers);
      seenHeaders.push(headers.get("x-team"));
      if (headers.get("authorization") !== "Bearer good") return new Response(null, { status: 401 });
      const body = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
          : { tools: [{ name: "search", description: "x".repeat(1_200) }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const signedIn = await probeMcpServer(remote, { fetch: fetchTools, getToken: async () => "good" });
    expect(signedIn).toEqual({ ok: true, tools: [{ name: "search", description: "x".repeat(1_000) }] });
    expect(seenHeaders[0]).toBe("a");

    const rejected: string[] = [];
    const signedOut = await probeMcpServer(remote, {
      fetch: fetchTools,
      getToken: async () => "old",
      onSignInRejected: (token) => void rejected.push(token),
    });
    expect(signedOut).toEqual({ ok: false, tools: [], needsSignIn: true, problem: "Sign in to Linear first." });
    expect(rejected).toEqual(["old"]);
  });
});

describe("runStdioRelay", () => {
  it("relays both ways and hides turned-off tools", async () => {
    const { server } = await fakeServer();
    const input = new PassThrough();
    const output: unknown[] = [];
    const done = runStdioRelay({
      name: "fake",
      spec: { command: server.command, args: server.args, env: server.env },
      hiddenTools: ["tool1"],
      input,
      output: { write: (line: string) => output.push(JSON.parse(line)) },
    });
    const send = (message: unknown) => input.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tool1" } });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "tool0" } });
    await vi.waitFor(() => expect(output).toHaveLength(4));
    const byId = (id: number) => output.find((message) => (message as { id: number }).id === id);
    expect(byId(2)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "tool0", description: "Tool 0" }], nextCursor: "2" },
    });
    expect(byId(3)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32602, message: "tool1 is turned off for fake in ZLI." },
    });
    expect(byId(4)).toMatchObject({ result: { content: [{ text: "called tool0" }] } });
    input.end();
    await expect(done).resolves.toBe(0);
  });

  it("says why the server did not start", async () => {
    const logs: string[] = [];
    const code = await runStdioRelay({
      name: "missing",
      spec: { command: "npx-not-here", args: [], env: {} },
      input: new PassThrough(),
      output: { write: () => undefined },
      log: (message) => logs.push(message),
    });
    expect(code).toBe(1);
    expect(logs).toEqual([
      "ZLI could not start npx-not-here. Check that npx-not-here is installed and on your PATH, then try again.",
    ]);
  });
});
