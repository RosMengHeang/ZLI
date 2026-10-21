import { describe, expect, it } from "vitest";

import { type DevServerProjection, parseDevServerUrl, pruneDevServers, upsertDevServer } from "./devServers.js";

const worktreeId = "00000000-0000-4000-8000-000000000a01" as DevServerProjection["worktreeId"];
const terminalId = "00000000-0000-4000-8000-000000000a02" as DevServerProjection["terminalId"];

function server(port: number, terminal = terminalId): DevServerProjection {
  return {
    worktreeId,
    terminalId: terminal,
    url: `http://localhost:${port}/`,
    port,
    detectedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("parseDevServerUrl", () => {
  it("keeps loopback addresses and opens wildcard binds as localhost", () => {
    expect(parseDevServerUrl("http://localhost:5173/")).toEqual({ url: "http://localhost:5173/", port: 5173 });
    expect(parseDevServerUrl("http://127.0.0.1:8000")).toEqual({ url: "http://127.0.0.1:8000/", port: 8000 });
    expect(parseDevServerUrl("https://[::1]:8443/app/")).toEqual({ url: "https://[::1]:8443/app/", port: 8443 });
    expect(parseDevServerUrl("http://0.0.0.0:3000/?debug=1#top")).toEqual({
      url: "http://localhost:3000/",
      port: 3000,
    });
    expect(parseDevServerUrl("http://[::]:4000/")).toEqual({ url: "http://localhost:4000/", port: 4000 });
  });

  it("rejects remote hosts, other schemes, missing ports, and credentials", () => {
    expect(parseDevServerUrl("http://192.168.1.5:5173/")).toBeUndefined();
    expect(parseDevServerUrl("http://example.com:3000/")).toBeUndefined();
    expect(parseDevServerUrl("ftp://localhost:21/")).toBeUndefined();
    expect(parseDevServerUrl("http://localhost/")).toBeUndefined();
    expect(parseDevServerUrl("http://user:secret@localhost:3000/")).toBeUndefined();
    expect(parseDevServerUrl("not a url")).toBeUndefined();
  });
});

describe("dev server records", () => {
  it("replaces a port's record and keeps at most four per terminal", () => {
    let servers: DevServerProjection[] = [];
    for (const port of [3000, 3001, 3002, 3003, 3004]) servers = upsertDevServer(servers, server(port));
    expect(servers.map((entry) => entry.port)).toEqual([3001, 3002, 3003, 3004]);
    servers = upsertDevServer(servers, { ...server(3002), url: "http://localhost:3002/docs/" });
    expect(servers.map((entry) => entry.port)).toEqual([3001, 3003, 3004, 3002]);
    expect(servers.at(-1)?.url).toBe("http://localhost:3002/docs/");
  });

  it("drops servers whose terminal stopped or whose worktree is gone, and keeps identity otherwise", () => {
    const devServers = [server(3000)];
    const terminal = { terminalId, worktreeId, title: "Terminal", lastSequence: 0 };
    const worktrees = [
      { worktreeId, projectId: worktreeId as never, path: "/repo", branch: "main", status: "ready" as const },
    ];
    expect(pruneDevServers({ devServers, terminals: [{ ...terminal, status: "running" }], worktrees })).toBe(
      devServers,
    );
    expect(pruneDevServers({ devServers, terminals: [{ ...terminal, status: "exited" }], worktrees })).toEqual([]);
    expect(pruneDevServers({ devServers, terminals: [], worktrees })).toEqual([]);
    expect(pruneDevServers({ devServers, terminals: [{ ...terminal, status: "running" }], worktrees: [] })).toEqual([]);
  });
});
