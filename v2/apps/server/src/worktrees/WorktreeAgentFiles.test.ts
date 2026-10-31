import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { isConfined } from "./confinedPath.js";
import {
  EXCLUDE_END,
  EXCLUDE_START,
  WorktreeAgentFiles,
  withExcludeLines,
  withoutExcludeBlock,
} from "./WorktreeAgentFiles.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}

/** A repository with one commit and a linked worktree, the way ZLI lays them out. */
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "zli-agent-files-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "zli-tests@example.invalid");
  await git(repo, "config", "user.name", "ZLI Tests");
  await writeFile(join(repo, "README.md"), "initial\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  const worktree = join(root, "repo-worktrees", "feature");
  await git(repo, "worktree", "add", "-b", "feature", worktree);
  const exclude = join(repo, ".git", "info", "exclude");
  const files = new WorktreeAgentFiles({ statePath: join(root, "data", "worktree-files.json") });
  await files.load();
  return { root, repo, worktree, exclude, files };
}

const contents = '{\n  "mcpServers": { "zli": { "type": "stdio", "command": "zli" } }\n}\n';

describe("WorktreeAgentFiles", () => {
  it("writes a private file, hides it from git once, and removes all of it again", async () => {
    const { repo, worktree, exclude, files } = await repository();
    const before = await readFile(exclude, "utf8").catch(() => "");
    const path = join(worktree, ".factory", "mcp.json");

    expect(await files.writeFile(worktree, ".factory/mcp.json", contents)).toBe(true);
    expect(await files.writeFile(worktree, ".factory/mcp.json", contents.replace("zli", "zli-new"))).toBe(true);
    expect(await files.writeFile(repo, ".factory/mcp.json", contents)).toBe(true);
    expect(await readFile(path, "utf8")).toContain("zli-new");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    const excluded = await readFile(exclude, "utf8");
    expect(excluded.split("\n").filter((line) => line === "/.factory/mcp.json")).toHaveLength(1);
    expect(excluded).toContain(`${EXCLUDE_START}\n/.factory/mcp.json\n${EXCLUDE_END}\n`);
    expect(await git(worktree, "status", "--porcelain")).toBe("");
    expect(await git(repo, "status", "--porcelain")).toBe("");

    await files.removeAll();
    await expect(stat(join(worktree, ".factory"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(repo, ".factory"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(exclude, "utf8")).toBe(before);
  });

  it("leaves a file it did not write alone, and does not hide it", async () => {
    const { worktree, exclude, files } = await repository();
    await mkdir(join(worktree, ".cursor"));
    const theirs = '{ "mcpServers": { "team": { "command": "team-mcp" } } }\n';
    await writeFile(join(worktree, ".cursor", "mcp.json"), theirs);
    const before = await readFile(exclude, "utf8").catch(() => "");

    expect(await files.writeFile(worktree, ".cursor/mcp.json", contents)).toBe(false);
    expect(await files.writeFile(worktree, ".cursor/mcp.json", undefined)).toBe(false);
    expect(await readFile(join(worktree, ".cursor", "mcp.json"), "utf8")).toBe(theirs);
    expect(await readFile(exclude, "utf8").catch(() => "")).toBe(before);
    await files.removeAll();
    expect(await readFile(join(worktree, ".cursor", "mcp.json"), "utf8")).toBe(theirs);
  });

  it("stops managing a file the person changed after ZLI wrote it", async () => {
    const { worktree, files } = await repository();
    const path = join(worktree, ".gemini", "settings.json");
    expect(await files.writeFile(worktree, ".gemini/settings.json", contents)).toBe(true);
    await writeFile(path, '{ "theme": "mine" }\n');
    expect(await files.writeFile(worktree, ".gemini/settings.json", contents)).toBe(false);
    await files.removeAll();
    expect(await readFile(path, "utf8")).toBe('{ "theme": "mine" }\n');
  });

  it("removes its own file when there is nothing left to give the agent", async () => {
    const { worktree, files } = await repository();
    expect(await files.writeFile(worktree, ".qwen/settings.json", contents)).toBe(true);
    expect(await files.writeFile(worktree, ".qwen/settings.json", undefined)).toBe(false);
    await expect(stat(join(worktree, ".qwen", "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up what a run that did not shut down left behind", async () => {
    const { root, worktree, exclude, files } = await repository();
    const before = await readFile(exclude, "utf8").catch(() => "");
    await files.writeFile(worktree, ".factory/mcp.json", contents);
    await files.makeDir(worktree, ".claude/skills");
    await files.hide(worktree, [".claude/skills/review/"]);
    await mkdir(join(worktree, ".claude", "skills", "review"));
    expect(await readFile(exclude, "utf8")).toContain("/.claude/skills/review/\n");
    expect(await git(worktree, "status", "--porcelain")).toBe("");

    // The skill copy itself is removed by the skill store; the folders it sat in go once empty.
    await rm(join(worktree, ".claude", "skills", "review"), { recursive: true });
    const restarted = new WorktreeAgentFiles({ statePath: join(root, "data", "worktree-files.json") });
    await restarted.load();
    await restarted.removeAll();
    expect((await readdir(worktree)).sort()).toEqual([".git", "README.md"]);
    expect(await readFile(exclude, "utf8")).toBe(before);
    expect(JSON.parse(await readFile(join(root, "data", "worktree-files.json"), "utf8"))).toEqual({
      version: 1,
      files: {},
      roots: {},
      dirs: [],
      excludes: [],
    });
  });

  it("keeps a folder ZLI made once the person puts something in it", async () => {
    const { worktree, files } = await repository();
    await files.writeFile(worktree, ".factory/mcp.json", contents);
    await writeFile(join(worktree, ".factory", "notes.md"), "mine\n");
    await files.removeAll();
    expect(await readdir(join(worktree, ".factory"))).toEqual(["notes.md"]);
  });

  it("writes into a plain folder outside git", async () => {
    const root = await mkdtemp(join(tmpdir(), "zli-agent-files-plain-"));
    roots.push(root);
    const folder = join(root, "plain");
    await mkdir(folder);
    const files = new WorktreeAgentFiles({ statePath: join(root, "state.json") });
    expect(await files.writeFile(folder, ".factory/mcp.json", contents)).toBe(true);
    expect(await readFile(join(folder, ".factory", "mcp.json"), "utf8")).toBe(contents);
    await files.removeAll();
    expect(await readdir(folder)).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("links in a worktree", () => {
  it("does not write through a linked folder inside the worktree", async () => {
    const { worktree, exclude, files } = await repository();
    const before = await readFile(exclude, "utf8").catch(() => "");
    await mkdir(join(worktree, "public", "config"), { recursive: true });
    await symlink(join(worktree, "public", "config"), join(worktree, ".factory"), "dir");
    expect(await files.writeFile(worktree, ".factory/mcp.json", contents)).toBe(false);
    expect(await readdir(join(worktree, "public", "config"))).toEqual([]);
    expect(await readFile(exclude, "utf8").catch(() => "")).toBe(before);
  });

  it("does not write through a link that leaves the worktree, or to a linked file", async () => {
    const { root, worktree, files } = await repository();
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(worktree, ".cursor"), "dir");
    expect(await files.writeFile(worktree, ".cursor/mcp.json", contents)).toBe(false);
    await expect(files.makeDir(worktree, ".cursor/skills")).rejects.toThrow("is a link");
    expect(await readdir(outside)).toEqual([]);

    await mkdir(join(worktree, ".gemini"));
    await writeFile(join(outside, "settings.json"), contents);
    await symlink(join(outside, "settings.json"), join(worktree, ".gemini", "settings.json"));
    expect(await files.writeFile(worktree, ".gemini/settings.json", contents)).toBe(false);
    expect(await files.writeFile(worktree, ".gemini/settings.json", undefined)).toBe(false);
    expect(await readFile(join(outside, "settings.json"), "utf8")).toBe(contents);
  });

  it("does not remove a file once a link replaces a folder above it", async () => {
    const { root, worktree, files } = await repository();
    expect(await files.writeFile(worktree, ".factory/mcp.json", contents)).toBe(true);
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "mcp.json"), contents);
    await rm(join(worktree, ".factory"), { recursive: true });
    await symlink(outside, join(worktree, ".factory"), "dir");
    await files.removeAll();
    expect(await readFile(join(outside, "mcp.json"), "utf8")).toBe(contents);
  });

  it("tells apart paths that stay inside the worktree", async () => {
    const { root, worktree } = await repository();
    await mkdir(join(worktree, "real"));
    await symlink(join(worktree, "real"), join(worktree, "linked"), "dir");
    await writeFile(join(worktree, "file"), "");
    expect(await isConfined(worktree, ".factory/mcp.json")).toBe(true);
    expect(await isConfined(worktree, "real/mcp.json")).toBe(true);
    expect(await isConfined(worktree, "linked/mcp.json")).toBe(false);
    expect(await isConfined(worktree, "linked")).toBe(false);
    expect(await isConfined(worktree, "file/mcp.json")).toBe(false);
    expect(await isConfined(worktree, "../outside")).toBe(false);
    expect(await isConfined(worktree, "")).toBe(false);
    // The worktree folder itself may sit behind a link.
    await symlink(worktree, join(root, "via-link"), "dir");
    expect(await isConfined(join(root, "via-link"), "real/mcp.json")).toBe(true);
  });
});

describe("exclude blocks", () => {
  it("adds lines once inside ZLI's block and keeps the rest of the file and its line endings", () => {
    const original = "# git ls-files --others --exclude-from=.git/info/exclude\r\n*.log\r\n";
    const once = withExcludeLines(original, ["/.factory/mcp.json"]);
    expect(once).toBe(`${original}${EXCLUDE_START}\r\n/.factory/mcp.json\r\n${EXCLUDE_END}\r\n`);
    expect(withExcludeLines(once, ["/.factory/mcp.json"])).toBe(once);
    const twice = withExcludeLines(once, ["/.cursor/mcp.json", "/.factory/mcp.json"]);
    expect(twice).toBe(`${original}${EXCLUDE_START}\r\n/.factory/mcp.json\r\n/.cursor/mcp.json\r\n${EXCLUDE_END}\r\n`);
    expect(withoutExcludeBlock(twice)).toBe(original);
    expect(withoutExcludeBlock(withExcludeLines("", ["/a"]))).toBe("");
    expect(withoutExcludeBlock(original)).toBe(original);
  });
});
