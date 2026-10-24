import { PLUGIN_CATALOG } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { parseGithubSkillSource } from "../skills/githubSource.js";
import { DIRECTORY_UNREACHABLE, directoryEntries, directorySource, PluginDirectory } from "./pluginDirectory.js";

const sha = "faf5305385de8afed9468904e8639be737aff39e";

describe("plugin directory sources", () => {
  it("turns each GitHub source form into a link ZLI installs from", () => {
    expect(
      directorySource({
        source: "git-subdir",
        url: "https://github.com/acme/plugins.git",
        path: "plugins/a",
        ref: "v1",
        sha,
      }),
    ).toEqual({ source: `https://github.com/acme/plugins/tree/${sha}/plugins/a` });
    expect(
      directorySource({ source: "git-subdir", url: "https://github.com/acme/plugins.git", path: "./p", ref: "v1" }),
    ).toEqual({ source: "https://github.com/acme/plugins/tree/v1/p" });
    expect(directorySource({ source: "github", repo: "acme/tool" })).toEqual({
      source: "https://github.com/acme/tool/tree/HEAD",
    });
    expect(directorySource({ source: "github", repo: "acme/tool", ref: "main" })).toEqual({
      source: "https://github.com/acme/tool/tree/main",
    });
    expect(directorySource({ source: "url", url: "https://github.com/acme/tool.git", sha })).toEqual({
      source: `https://github.com/acme/tool/tree/${sha}`,
    });
    expect(directorySource("./plugins/code-review")).toEqual({
      source: "https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-review",
    });
    expect(directorySource("https://github.com/acme/tool")).toEqual({
      source: "https://github.com/acme/tool/tree/HEAD",
    });
  });

  it("explains sources ZLI cannot install", () => {
    const outside = { unsupported: "Hosted outside GitHub, so ZLI cannot install it yet." };
    expect(directorySource({ source: "url", url: "https://gitlab.com/acme/tool.git" })).toEqual(outside);
    expect(directorySource("https://example.com/plugin.zip")).toEqual(outside);
    const unknown = { unsupported: "ZLI cannot install this kind of source yet." };
    expect(directorySource({ source: "npm", package: "tool" })).toEqual(unknown);
    expect(directorySource("../outside")).toEqual(unknown);
    expect(directorySource({ source: "git-subdir", url: "https://github.com/a/b.git", path: "../x" })).toEqual(unknown);
    expect(directorySource({ source: "github", repo: "a/b", ref: "feature/x" })).toEqual(unknown);
    expect(directorySource(undefined)).toEqual(unknown);
  });

  it("reads directory entries with titles, publishers, and trimmed descriptions", () => {
    const entries = directoryEntries({
      plugins: [
        {
          name: "code-review",
          description: "Reviews\n pull requests.",
          author: { name: "Anthropic" },
          category: "productivity",
          source: "./plugins/code-review",
          homepage: "https://example.com/cr",
        },
        { name: "aws-cli-mcp", description: "x".repeat(600), source: { source: "github", repo: "a/b" } },
        { name: "pretty", displayName: "Pretty Name", source: "./plugins/pretty", homepage: "javascript:alert(1)" },
        { name: "clangd-lsp", source: "./plugins/clangd-lsp", lspServers: { clangd: {} } },
        { name: "code-review", source: "./dupe" },
        { description: "No name." },
        "junk",
      ],
    });
    expect(entries.map((entry) => entry.name)).toEqual(["code-review", "aws-cli-mcp", "pretty", "clangd-lsp"]);
    expect(entries[0]).toEqual({
      name: "code-review",
      title: "Code Review",
      description: "Reviews pull requests.",
      publisher: "Anthropic",
      category: "productivity",
      homepage: "https://example.com/cr",
      source: "https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-review",
    });
    expect(entries[1]?.title).toBe("AWS CLI MCP");
    expect(entries[1]?.description).toHaveLength(500);
    expect(entries[2]).toEqual({
      name: "pretty",
      title: "Pretty Name",
      description: "",
      source: "https://github.com/anthropics/claude-plugins-official/tree/main/plugins/pretty",
    });
    expect(entries[3]).toEqual(
      expect.objectContaining({ unsupported: "It only adds a language server, which ZLI does not use." }),
    );
    expect(entries[3]?.source).toBeUndefined();
    expect(directoryEntries({ nope: [] })).toEqual([]);
  });

  it("keeps the directory for an hour and the last good copy when GitHub cannot be reached", async () => {
    let now = 1_000;
    let calls = 0;
    let online = true;
    const fetchDirectory = (async () => {
      calls += 1;
      if (!online) throw new Error("offline");
      return Response.json({ plugins: [{ name: "one", source: "./plugins/one" }] });
    }) as unknown as typeof fetch;
    const directory = new PluginDirectory({ fetch: fetchDirectory, now: () => now });
    expect(directory.knownSources()).toEqual([]);
    const first = await directory.get();
    expect(first.entries.map((entry) => entry.name)).toEqual(["one"]);
    expect(first.problem).toBeUndefined();
    expect(directory.knownSources()).toEqual([
      "https://github.com/anthropics/claude-plugins-official/tree/main/plugins/one",
    ]);
    await directory.get();
    expect(calls).toBe(1);
    now += 61 * 60 * 1000;
    online = false;
    const stale = await directory.get();
    expect(calls).toBe(2);
    expect(stale.problem).toBe(DIRECTORY_UNREACHABLE);
    expect(stale.entries.map((entry) => entry.name)).toEqual(["one"]);

    const empty = await new PluginDirectory({ fetch: fetchDirectory }).get();
    expect(empty).toEqual({ entries: [], fetchedAt: expect.any(String), problem: DIRECTORY_UNREACHABLE });
  });
});

describe("built-in plugin catalog", () => {
  it("lists sources ZLI reads as GitHub folders", () => {
    for (const entry of PLUGIN_CATALOG) {
      const parsed = parseGithubSkillSource(entry.source);
      expect("problem" in parsed, entry.id).toBe(false);
      if (!("problem" in parsed)) expect(parsed.ref, entry.id).toBeTruthy();
    }
  });
});
