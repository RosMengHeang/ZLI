import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ThreadId } from "@zli-v2/contracts";
import { CursorAgentClient } from "@zli-v2/provider-cursor-agent";
import { DroidClient } from "@zli-v2/provider-droid";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpServerSpec } from "../browser-tool/browserTool.js";
import { projectMcpFileContents } from "../browser-tool/mcpSettingsFiles.js";
import type { CliProbe } from "./discoverCliProviders.js";
import {
  createProviderRegistry,
  resolveAcpCommand,
  resolveClaudeCommand,
  resolveCursorCommand,
  resolveDroidCommand,
} from "./registerProviders.js";

describe("createProviderRegistry", () => {
  it("registers Codex, Claude Code, Cursor, Droid, and the ACP agents", () => {
    const registry = createProviderRegistry({});
    expect(registry.list().map((adapter) => adapter.provider)).toEqual([
      "codex",
      "claude-code",
      "cursor-agent",
      "droid",
      "opencode",
      "gemini",
      "copilot",
      "kimi",
      "qwen",
      "goose",
    ]);
    for (const provider of ["opencode", "gemini", "copilot", "kimi", "qwen", "goose"] as const) {
      expect(registry.get(provider)?.capabilities).toEqual({
        exactResume: false,
        structuredApproval: true,
        structuredUserInput: false,
        conversationRollback: false,
        modelSwitch: "in-session",
      });
    }
    expect(registry.get("codex")?.capabilities).toMatchObject({
      exactResume: true,
      structuredApproval: true,
      conversationRollback: true,
    });
    expect(registry.get("claude-code")?.capabilities).toEqual({
      exactResume: false,
      structuredApproval: true,
      structuredUserInput: false,
      conversationRollback: false,
      modelSwitch: "in-session",
    });
    expect(registry.get("droid")?.capabilities).toEqual({
      exactResume: false,
      structuredApproval: true,
      structuredUserInput: true,
      conversationRollback: false,
      modelSwitch: "in-session",
      permissionSwitch: "in-session",
    });
    expect(registry.get("cursor-agent")?.capabilities).toEqual({
      exactResume: false,
      structuredApproval: false,
      structuredUserInput: false,
      conversationRollback: false,
      modelSwitch: "in-session",
      permissionSwitch: "in-session",
    });
  });

  it("keeps the integration harness on the mock provider", () => {
    const registry = createProviderRegistry({ ZLI_TEST_PROVIDER: "mock" });
    expect(registry.list().map((adapter) => adapter.provider)).toEqual(["codex"]);
  });
});

describe("Cursor and Droid chats", () => {
  const path = process.env.PATH;
  const temps: string[] = [];
  afterEach(async () => {
    process.env.PATH = path;
    vi.restoreAllMocks();
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const spec: McpServerSpec = { name: "docs", command: "docs-mcp", args: [], env: {} };
  const client = {
    sendTurn: vi.fn(),
    interruptTurn: vi.fn(),
    transcript: () => [],
    subscribe: () => () => {},
    close: vi.fn(),
  };

  /** Stand-in CLIs on PATH, so discovery finds them; the clients themselves are replaced. */
  async function fakeClis(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zli-fake-cli-"));
    temps.push(dir);
    for (const name of ["cursor-agent", "droid"]) {
      await writeFile(join(dir, name), "#!/bin/sh\nexit 0\n");
      await chmod(join(dir, name), 0o755);
    }
    process.env.PATH = dir;
    return dir;
  }

  it.skipIf(process.platform === "win32")(
    "write ZLI's project MCP file in the worktree before the chat starts, and approve only that file",
    async () => {
      const worktree = await fakeClis();
      const writes: Array<[string, string, string | undefined]> = [];
      let ours = true;
      const registry = createProviderRegistry(
        {},
        {
          mcpServers: async () => [spec],
          writeWorktreeFile: async (worktreePath, relPath, contents) => {
            writes.push([worktreePath, relPath, contents]);
            return ours;
          },
        },
      );
      const cursorStart = vi.spyOn(CursorAgentClient, "start").mockResolvedValue(client as never);
      const droidStart = vi.spyOn(DroidClient, "start").mockResolvedValue(client as never);
      const threadId = ThreadId.parse("33333333-3333-4333-8333-333333333333");

      await registry.get("cursor-agent")?.startSession({ threadId, cwd: worktree, worktreeId: "wt-1" });
      await registry.get("droid")?.startSession({ threadId, cwd: worktree, worktreeId: "wt-1" });
      expect(writes).toEqual([
        [worktree, ".cursor/mcp.json", projectMcpFileContents("cursor-agent", [spec])],
        [worktree, ".factory/mcp.json", projectMcpFileContents("droid", [spec])],
      ]);
      expect(cursorStart).toHaveBeenLastCalledWith(expect.objectContaining({ approveMcps: true }));
      expect(droidStart).toHaveBeenCalledTimes(1);

      // A .cursor/mcp.json the repository brings is not ZLI's, so its servers are not approved.
      ours = false;
      await registry.get("cursor-agent")?.startSession({ threadId, cwd: worktree, worktreeId: "wt-1" });
      expect(cursorStart.mock.lastCall?.[0]).not.toHaveProperty("approveMcps");
    },
  );
});

describe("resolveClaudeCommand", () => {
  it("returns the discovered Claude path and a typed error when discovery misses it", async () => {
    const found: CliProbe = {
      pathEntries: ["/tools"],
      platform: "linux",
      fileExists: (filePath) => filePath === "/tools/claude",
    };
    const missing: CliProbe = {
      pathEntries: [],
      platform: "linux",
      fileExists: () => false,
    };

    await expect(resolveClaudeCommand(found)).resolves.toBe("/tools/claude");
    await expect(resolveClaudeCommand(missing)).rejects.toMatchObject({
      code: "cli_missing",
      message: "Claude Code CLI was not found on PATH or in known install locations.",
    });
  });
});

describe("resolveCursorCommand", () => {
  it("returns the discovered Cursor path and a typed error when discovery misses it", async () => {
    const found: CliProbe = {
      pathEntries: ["/tools"],
      platform: "linux",
      fileExists: (filePath) => filePath === "/tools/cursor-agent",
    };
    const missing: CliProbe = {
      pathEntries: [],
      platform: "linux",
      fileExists: () => false,
    };

    await expect(resolveCursorCommand(found)).resolves.toBe("/tools/cursor-agent");
    await expect(resolveCursorCommand(missing)).rejects.toMatchObject({
      code: "cli_missing",
      message: "Cursor CLI was not found on PATH or in known install locations.",
    });
  });
});

describe("resolveAcpCommand", () => {
  it("returns the discovered Kimi Code path and a typed error when discovery misses Goose", async () => {
    const found: CliProbe = {
      pathEntries: [],
      homeDir: "C:\\Users\\dev",
      platform: "win32",
      fileExists: (filePath) => filePath === "C:\\Users\\dev\\.kimi-code\\bin\\kimi.exe",
    };
    await expect(resolveAcpCommand("kimi", found)).resolves.toBe("C:\\Users\\dev\\.kimi-code\\bin\\kimi.exe");
    await expect(resolveAcpCommand("goose", found)).rejects.toMatchObject({
      code: "cli_missing",
      message: "Goose CLI was not found on PATH or in known install locations.",
    });
  });
});

describe("resolveDroidCommand", () => {
  it("returns the discovered Droid path from ~/bin and a typed error when discovery misses it", async () => {
    const found: CliProbe = {
      pathEntries: [],
      homeDir: "C:\\Users\\dev",
      platform: "win32",
      fileExists: (filePath) => filePath === "C:\\Users\\dev\\bin\\droid.exe",
    };
    const missing: CliProbe = {
      pathEntries: [],
      platform: "linux",
      fileExists: () => false,
    };

    await expect(resolveDroidCommand(found)).resolves.toBe("C:\\Users\\dev\\bin\\droid.exe");
    await expect(resolveDroidCommand(missing)).rejects.toMatchObject({
      code: "cli_missing",
      message: "Droid CLI was not found on PATH or in known install locations.",
    });
  });
});
