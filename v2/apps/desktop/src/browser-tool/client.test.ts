import { describe, expect, it } from "vitest";

import { createZliBrowserClient, ZLI_NOT_RUNNING_MESSAGE, ZliBrowserUnavailableError } from "./client.js";

const endpoint = JSON.stringify({ version: 1, port: 4100, token: "f".repeat(64), pid: 77 });

describe("zli-browser client", () => {
  it("re-reads the endpoint and forwards cwd and the agent's worktree id", async () => {
    const posted: Array<{ port: number; action: string; body: unknown }> = [];
    let file = endpoint;
    const call = createZliBrowserClient({
      env: { ZLI_BROWSER_CONTROL_FILE: "/state/browser-control.json", ZLI_WORKTREE_ID: "wt-1" },
      cwd: () => "/repo/web",
      readFile: async () => file,
      isProcessAlive: () => true,
      post: async (target, action, body) => {
        posted.push({ port: target.port, action, body: JSON.parse(body) });
        return { status: 200, body: JSON.stringify({ ok: true, result: { done: action } }) };
      },
    });
    expect(await call("snapshot", { browserTabId: undefined })).toEqual({ done: "snapshot" });
    file = JSON.stringify({ ...JSON.parse(endpoint), port: 4200 });
    await call("open", { url: "http://localhost:3000", cwd: "/elsewhere" });
    expect(posted).toEqual([
      { port: 4100, action: "snapshot", body: { cwd: "/repo/web", defaultWorktreeId: "wt-1" } },
      {
        port: 4200,
        action: "open",
        body: { url: "http://localhost:3000", cwd: "/elsewhere", defaultWorktreeId: "wt-1" },
      },
    ]);
  });

  it("reports ZLI as not running when it is closed, crashed, or never started this process", async () => {
    const base = {
      env: { ZLI_BROWSER_CONTROL_FILE: "/state/browser-control.json" },
      readFile: async () => endpoint,
      isProcessAlive: () => true,
    };
    await expect(createZliBrowserClient({ env: {} })("tabs")).rejects.toThrow("ZLI_BROWSER_CONTROL_FILE is not set");
    await expect(
      createZliBrowserClient({
        ...base,
        readFile: async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      })("tabs"),
    ).rejects.toThrow(ZLI_NOT_RUNNING_MESSAGE);
    await expect(createZliBrowserClient({ ...base, readFile: async () => "{" })("tabs")).rejects.toBeInstanceOf(
      ZliBrowserUnavailableError,
    );
    await expect(createZliBrowserClient({ ...base, isProcessAlive: () => false })("tabs")).rejects.toBeInstanceOf(
      ZliBrowserUnavailableError,
    );
    await expect(
      createZliBrowserClient({
        ...base,
        post: async () => {
          throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        },
      })("tabs"),
    ).rejects.toBeInstanceOf(ZliBrowserUnavailableError);
    await expect(
      createZliBrowserClient({
        ...base,
        post: async () => ({ status: 401, body: JSON.stringify({ ok: false, error: "bad token" }) }),
      })("tabs"),
    ).rejects.toThrow("stale");
  });

  it("surfaces action errors from ZLI", async () => {
    const call = createZliBrowserClient({
      env: { ZLI_BROWSER_CONTROL_FILE: "/state/browser-control.json" },
      readFile: async () => endpoint,
      isProcessAlive: () => true,
      post: async () => ({ status: 404, body: JSON.stringify({ ok: false, error: "No browser tab is open." }) }),
    });
    await expect(call("snapshot")).rejects.toThrow("No browser tab is open.");
    await expect(call("snapshot")).rejects.not.toBeInstanceOf(ZliBrowserUnavailableError);
  });
});
