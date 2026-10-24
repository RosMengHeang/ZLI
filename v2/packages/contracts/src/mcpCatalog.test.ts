import { describe, expect, it } from "vitest";

import { McpServerConfig, McpServerList } from "./mcp.js";
import {
  catalogEntryAdded,
  catalogMissingField,
  catalogServer,
  catalogSignsIn,
  MCP_CATALOG,
  MCP_CATALOG_CATEGORIES,
} from "./mcpCatalog.js";

const sample = (key: string) => (key === "folder" ? "/home/me/notes" : `value-${key}`);

describe("MCP catalog", () => {
  it("has unique ids that are valid server names", () => {
    const ids = MCP_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(MCP_CATALOG.length).toBeGreaterThanOrEqual(12);
    for (const entry of MCP_CATALOG) {
      expect(entry.homepage).toMatch(/^https:\/\//u);
      expect(entry.costLabel.length).toBeGreaterThan(0);
    }
  });

  it.each(MCP_CATALOG.map((entry) => [entry.id, entry] as const))(
    "%s parses as a server once its fields are filled in",
    (_, entry) => {
      const values = Object.fromEntries(entry.fields.map((field) => [field.key, sample(field.key)]));
      expect(catalogMissingField(entry, values)).toBeUndefined();
      const server = catalogServer(entry, values);
      expect(McpServerConfig.safeParse(server).success).toBe(true);
      expect(JSON.stringify(server)).not.toContain("{{");
      for (const windows of [true, false]) {
        expect(McpServerConfig.safeParse(catalogServer(entry, values, { windows })).success).toBe(true);
      }
    },
  );

  it("can add every entry to one list", () => {
    const servers = MCP_CATALOG.map((entry) =>
      catalogServer(entry, Object.fromEntries(entry.fields.map((field) => [field.key, sample(field.key)]))),
    );
    expect(McpServerList.safeParse(servers).success).toBe(true);
  });

  it("asks for required fields and leaves out optional ones left empty", () => {
    const render = MCP_CATALOG.find((entry) => entry.id === "render");
    const context7 = MCP_CATALOG.find((entry) => entry.id === "context7");
    const filesystem = MCP_CATALOG.find((entry) => entry.id === "filesystem");
    if (!render || !context7 || !filesystem) throw new Error("catalog entries missing");
    expect(catalogMissingField(render, { apiKey: "  " })?.key).toBe("apiKey");
    expect(catalogServer(render, { apiKey: " rnd_1 " })).toMatchObject({
      transport: "http",
      headers: { Authorization: "Bearer rnd_1" },
      oauth: false,
    });
    expect(catalogMissingField(context7, {})).toBeUndefined();
    expect(catalogServer(context7, {})).toMatchObject({ transport: "http", headers: {} });
    expect(catalogServer(filesystem, { folder: "C:\\notes" }, { windows: true })).toEqual({
      name: "filesystem",
      enabled: true,
      command: "cmd",
      args: ["/c", "npx", "-y", "@modelcontextprotocol/server-filesystem", "C:\\notes"],
      env: {},
    });
  });

  it("signs in to hosted services, with a token as GitHub's second way in", () => {
    const github = MCP_CATALOG.find((entry) => entry.id === "github");
    if (!github) throw new Error("catalog entries missing");
    expect(catalogSignsIn(github)).toBe(true);
    expect(catalogServer(github, {})).toMatchObject({ transport: "http", headers: {}, oauth: true });
    expect(catalogServer(github, { token: " ghp_1 " }, { useToken: true })).toMatchObject({
      transport: "http",
      headers: { Authorization: "Bearer ghp_1" },
      oauth: false,
    });
    const categories = new Set(MCP_CATALOG_CATEGORIES.map((category) => category.id));
    for (const entry of MCP_CATALOG) expect(categories.has(entry.category)).toBe(true);
    expect(MCP_CATALOG.filter(catalogSignsIn).length).toBeGreaterThanOrEqual(30);
  });

  it("knows which entries were already added, by name, URL, or package", () => {
    const linear = MCP_CATALOG.find((entry) => entry.id === "linear");
    const playwright = MCP_CATALOG.find((entry) => entry.id === "playwright");
    if (!linear || !playwright) throw new Error("catalog entries missing");
    const remote = { name: "work-linear", enabled: true, transport: "http" as const, headers: {}, oauth: true };
    expect(catalogEntryAdded(linear, [{ ...remote, url: "https://mcp.linear.app/mcp/" }])).toBe(true);
    expect(catalogEntryAdded(linear, [{ ...remote, url: "https://mcp.notion.com/mcp" }])).toBe(false);
    const browser = {
      name: "browser",
      enabled: true,
      command: "cmd",
      args: ["/c", "npx", "-y", "@playwright/mcp@latest"],
      env: {},
    };
    expect(catalogEntryAdded(playwright, [browser])).toBe(true);
    expect(catalogEntryAdded(playwright, [{ ...browser, name: "Playwright", args: [] }])).toBe(true);
    expect(catalogEntryAdded(playwright, [{ ...browser, args: ["x"] }])).toBe(false);
  });
});
