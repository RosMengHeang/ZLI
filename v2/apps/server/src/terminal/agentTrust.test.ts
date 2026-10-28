import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agentFolderTrust } from "./agentTrust.js";

describe("agentFolderTrust", () => {
  let home = "";
  let project = "";
  let worktree = "";
  const now = () => new Date("2026-10-28T10:00:00.000Z");

  beforeEach(async () => {
    // macOS links the temp folder under /private and Windows gives it a short name, so resolve it to
    // keep the folder ZLI knows and the folder the system resolves the same.
    home = await realpath(await mkdtemp(join(tmpdir(), "zli-trust-")));
    project = join(home, "my.app");
    worktree = join(home, "my.app-worktrees", "feature");
    await mkdir(project, { recursive: true });
    await mkdir(worktree, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const trust = (provider: Parameters<typeof agentFolderTrust>[0], env: NodeJS.ProcessEnv = {}) =>
    agentFolderTrust(provider, { projectPath: project, cwd: worktree, env, home, platform: "linux", now });

  it("passes Gemini's flag and Kimi's variable for one launch", async () => {
    expect(await trust("gemini")).toEqual({ args: ["--skip-trust"], env: {} });
    expect(await trust("kimi")).toEqual({ args: [], env: { KIMI_CODE_TRUST_WORKSPACE: "1" } });
    expect(await trust("qwen")).toEqual({ args: [], env: {} });
  });

  it("marks the project trusted in Claude Code's config and keeps everything else", async () => {
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ theme: "dark", projects: { [project]: { allowedTools: ["Bash"] } } }),
    );
    expect(await trust("claude-code")).toEqual({ args: [], env: {} });
    const config = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    expect(config.theme).toBe("dark");
    expect(config.projects[project]).toEqual({ allowedTools: ["Bash"], hasTrustDialogAccepted: true });
  });

  it("writes to the account's config directory when one is set", async () => {
    const account = join(home, "account");
    await trust("claude-code", { CLAUDE_CONFIG_DIR: account });
    const config = JSON.parse(await readFile(join(account, ".claude.json"), "utf8"));
    expect(config.projects[project].hasTrustDialogAccepted).toBe(true);
  });

  it("appends a trusted project table to Codex's config.toml once", async () => {
    await mkdir(join(home, ".codex"));
    await writeFile(join(home, ".codex", "config.toml"), 'model = "gpt-6"');
    await trust("codex");
    await trust("codex");
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toBe(
      `model = "gpt-6"\n\n[projects."${project.replaceAll("\\", "\\\\")}"]\ntrust_level = "trusted"\n`,
    );
  });

  it("leaves a project Codex already lists alone", async () => {
    await mkdir(join(home, ".codex"));
    const text = `[projects.'${project}']\ntrust_level = "untrusted"\n`;
    await writeFile(join(home, ".codex", "config.toml"), text);
    await trust("codex");
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toBe(text);
  });

  it("adds the project to Copilot's trusted folders and keeps its comment header", async () => {
    await mkdir(join(home, ".copilot"));
    await writeFile(
      join(home, ".copilot", "config.json"),
      '// This file is managed automatically.\n{\n  "trustedFolders": ["/elsewhere"]\n}\n',
    );
    await trust("copilot");
    const text = await readFile(join(home, ".copilot", "config.json"), "utf8");
    expect(text.startsWith("// This file is managed automatically.\n{")).toBe(true);
    expect(JSON.parse(text.slice(text.indexOf("{"))).trustedFolders).toEqual(["/elsewhere", project]);
  });

  it("trusts both the linked folder and the folder it resolves to", async () => {
    const link = join(home, "linked.app");
    await symlink(project, link, "junction");
    await agentFolderTrust("copilot", { projectPath: link, cwd: link, env: {}, home, platform: "linux" });
    const config = JSON.parse(await readFile(join(home, ".copilot", "config.json"), "utf8"));
    expect(config.trustedFolders).toEqual([link, project]);
  });

  it("trusts the worktree itself in Droid's settings", async () => {
    await trust("droid");
    const settings = JSON.parse(await readFile(join(home, ".factory", "settings.json"), "utf8"));
    expect(settings.general.trustedFolders).toEqual({ [worktree]: { trustedAt: "2026-10-28T10:00:00.000Z" } });
  });

  it("leaves a settings file it cannot parse untouched", async () => {
    await mkdir(join(home, ".factory"));
    const text = '{ "general": { /* comment */ } }';
    await writeFile(join(home, ".factory", "settings.json"), text);
    expect(await trust("droid")).toEqual({ args: [], env: {} });
    expect(await readFile(join(home, ".factory", "settings.json"), "utf8")).toBe(text);
  });

  it("writes Windows paths for Claude Code with forward slashes as well", async () => {
    await agentFolderTrust("claude-code", {
      projectPath: "C:\\Users\\me\\app",
      cwd: "C:\\Users\\me\\app",
      env: {},
      home,
      platform: "win32",
    });
    const config = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    expect(Object.keys(config.projects)).toEqual(["C:\\Users\\me\\app", "C:/Users/me/app"]);
  });
});
