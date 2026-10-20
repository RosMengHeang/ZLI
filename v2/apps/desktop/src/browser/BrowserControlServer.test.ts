import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserControlOpenInput } from "@zli-v2/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BrowserControlError } from "./BrowserControlActions.js";
import { BrowserControlServer } from "./BrowserControlServer.js";

const TOKEN = "a".repeat(64);

function post(
  port: number,
  path: string,
  options: { token?: string; body?: string; method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: { ok: boolean; result?: unknown; error?: string } }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "POST",
        headers: {
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
          "content-type": "application/json",
          ...options.headers,
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({ status: incoming.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(options.body ?? "{}");
  });
}

describe("BrowserControlServer", () => {
  let directory: string;
  let server: BrowserControlServer | undefined;
  const calls: Array<{ action: string; input: unknown }> = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "zli-browser-control-"));
    calls.length = 0;
  });

  afterEach(async () => {
    server?.stop();
    server = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  const start = async () => {
    server = new BrowserControlServer({
      endpointPath: join(directory, "browser-control.json"),
      token: TOKEN,
      pid: 4242,
      dispatch: async (action, input) => {
        calls.push({ action, input });
        if (action === "missing") throw new BrowserControlError("No browser tab is open.", 404);
        if (action === "invalid") BrowserControlOpenInput.parse(input);
        if (action === "boom") throw new Error("Chromium went away.");
        return { echoed: input };
      },
    });
    return server.start();
  };

  it("publishes a loopback endpoint and routes authorized actions", async () => {
    const endpoint = await start();
    const written = JSON.parse(await readFile(join(directory, "browser-control.json"), "utf8"));
    expect(written).toEqual({ version: 1, port: endpoint.port, token: TOKEN, pid: 4242 });

    const response = await post(endpoint.port, "/v1/snapshot", { token: TOKEN, body: '{"cwd":"/repo"}' });
    expect(response).toEqual({ status: 200, body: { ok: true, result: { echoed: { cwd: "/repo" } } } });
    expect(calls).toEqual([{ action: "snapshot", input: { cwd: "/repo" } }]);
  });

  it("rejects missing or wrong tokens and any request carrying a browser Origin", async () => {
    const { port } = await start();
    expect((await post(port, "/v1/tabs")).status).toBe(401);
    expect((await post(port, "/v1/tabs", { token: "b".repeat(64) })).status).toBe(401);
    expect((await post(port, "/v1/tabs", { token: TOKEN, headers: { origin: "http://evil.test" } })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("maps failures to HTTP statuses with readable messages", async () => {
    const { port } = await start();
    expect(await post(port, "/v1/missing", { token: TOKEN })).toEqual({
      status: 404,
      body: { ok: false, error: "No browser tab is open." },
    });
    const invalid = await post(port, "/v1/invalid", { token: TOKEN });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("url");
    expect(await post(port, "/v1/boom", { token: TOKEN })).toEqual({
      status: 500,
      body: { ok: false, error: "Chromium went away." },
    });
    expect((await post(port, "/v1/tabs", { token: TOKEN, body: "not json" })).status).toBe(400);
    expect((await post(port, "/v1/tabs", { token: TOKEN, body: "[1]" })).status).toBe(400);
    expect((await post(port, "/v1/tabs", { token: TOKEN, method: "PUT" })).status).toBe(405);
    expect((await post(port, "/other", { token: TOKEN })).status).toBe(404);
  });

  it("removes its endpoint file on stop but leaves a newer instance's file alone", async () => {
    await start();
    const path = join(directory, "browser-control.json");
    server?.stop();
    await expect(readFile(path, "utf8")).rejects.toThrow();

    await start();
    const newer = JSON.stringify({ version: 1, port: 1, token: "c".repeat(64), pid: 1 });
    await writeFile(path, newer);
    server?.stop();
    expect(await readFile(path, "utf8")).toBe(newer);
  });
});
