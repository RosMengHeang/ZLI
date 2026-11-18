import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConnectedApps } from "./ConnectedApps.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

type Call = { url: string; method: string; key: string | null; body: unknown };

/** A stand-in for Composio's API that records what it was asked. */
function fakeComposio(options: { reject?: boolean; mcpUrl?: string } = {}) {
  const calls: Call[] = [];
  const accounts = [{ id: "ca_1", status: "ACTIVE", toolkit: { slug: "gmail" } }];
  const fetch: typeof globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: input, method: init.method ?? "GET", key: headers.get("x-api-key"), body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (options.reject) return json({ message: "bad key" }, 401);
    if (input.endsWith("/tool_router/session"))
      return json({
        session_id: "trs_1",
        mcp: { url: options.mcpUrl ?? "https://backend.composio.dev/tool_router/trs_1/mcp" },
      });
    if (input.endsWith("/tool_router/session/trs_1/link"))
      return json({ redirect_url: "https://connect.composio.dev/link/abc" });
    if (input.includes("/connected_accounts?")) return json({ items: accounts });
    if (input.includes("/connected_accounts/ca_1")) {
      accounts.splice(0);
      return json({});
    }
    return json({ message: "not found" }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function store(fetch: typeof globalThis.fetch, onChange?: () => void) {
  const folder = mkdtempSync(join(tmpdir(), "zli-apps-"));
  folders.push(folder);
  const path = join(folder, "connected-apps.json");
  return { apps: new ConnectedApps({ path, fetch, ...(onChange ? { onChange } : {}) }), path };
}

describe("ConnectedApps", () => {
  it("gives agents no server until a key is saved, then Composio's with the key", async () => {
    const composio = fakeComposio();
    let changed = 0;
    const { apps, path } = store(composio.fetch, () => {
      changed += 1;
    });
    await apps.load();
    expect(apps.server()).toBeUndefined();

    const status = await apps.setKey("ak_test");
    expect(status).toEqual({ configured: true, accounts: [{ accountId: "ca_1", app: "gmail", status: "active" }] });
    expect(apps.server()).toEqual({
      name: "composio",
      enabled: true,
      transport: "http",
      url: "https://backend.composio.dev/tool_router/trs_1/mcp",
      headers: { "x-api-key": "ak_test" },
      oauth: false,
    });
    expect(changed).toBe(1);
    expect(composio.calls.every((call) => call.key === "ak_test")).toBe(true);
    // Kept for the next start.
    const again = new ConnectedApps({ path, fetch: composio.fetch });
    await again.load();
    expect(again.server()).toMatchObject({ url: "https://backend.composio.dev/tool_router/trs_1/mcp" });
    expect(JSON.parse(readFileSync(path, "utf8")).apiKey).toBe("ak_test");
  });

  it("refuses a key that is not a project key, or that Composio turns down, and keeps nothing", async () => {
    const { apps } = store(fakeComposio({ reject: true }).fetch);
    await expect(apps.setKey("ck_personal")).rejects.toThrow(/starts with ak_/u);
    await expect(apps.setKey("ak_wrong")).rejects.toThrow(/did not accept/u);
    expect(apps.server()).toBeUndefined();
  });

  it("refuses a session address that is not Composio's own, so the key never goes elsewhere", async () => {
    const { apps } = store(fakeComposio({ mcpUrl: "https://evil.example/mcp" }).fetch);
    await expect(apps.setKey("ak_test")).rejects.toThrow(/not its own/u);
    expect(apps.server()).toBeUndefined();
  });

  it("hands out a sign-in link for an app and disconnects an account", async () => {
    const composio = fakeComposio();
    const { apps } = store(composio.fetch);
    await apps.setKey("ak_test");
    expect(await apps.connect("Slack")).toEqual({ url: "https://connect.composio.dev/link/abc" });
    expect(composio.calls.find((call) => call.url.endsWith("/link"))?.body).toEqual({ toolkit: "slack" });
    await expect(apps.disconnect("ca_other")).rejects.toThrow(/not connected here/u);
    expect((await apps.disconnect("ca_1")).accounts).toEqual([]);
  });

  it("forgets the key when it is cleared", async () => {
    const { apps } = store(fakeComposio().fetch);
    await apps.setKey("ak_test");
    expect(await apps.setKey("")).toEqual({ configured: false, accounts: [] });
    expect(apps.server()).toBeUndefined();
    await expect(apps.connect("gmail")).rejects.toThrow(/key first/u);
  });
});

describe("ConnectedApps in the server list", () => {
  it("hands every agent the apps' server once a key is saved", async () => {
    const { McpServerStore } = await import("./McpServerStore.js");
    const { apps, path } = store(fakeComposio().fetch);
    const servers = new McpServerStore({ path: join(path, "..", "mcp-servers.json"), apps });
    await servers.load();
    expect(servers.specs().map((spec) => spec.name)).not.toContain("composio");
    await servers.appsKey("ak_test");
    expect(servers.specs().map((spec) => spec.name)).toContain("composio");
    // The person's own servers stay theirs to list and save; the apps' server is not one of them.
    expect(servers.list().servers).toEqual([]);
  });
});
