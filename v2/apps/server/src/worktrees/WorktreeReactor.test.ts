import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CommandId, type EnvironmentDescriptor, EnvironmentId, ProjectId, WorktreeId } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { Database } from "../db/Database.js";
import { GitProcess, GitProcessError } from "../git/GitProcess.js";
import { Engine } from "../orchestration/Engine.js";
import { WorktreeReactor } from "./WorktreeReactor.js";
import { WorktreeService } from "./WorktreeService.js";

const execFileAsync = promisify(execFile);
const environment: EnvironmentDescriptor = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000201"),
  label: "Worktree test environment",
  protocolVersion: 1,
  capabilities: { eventReplay: true, worktrees: true },
};
const databases: Database[] = [];
const reactors: WorktreeReactor[] = [];
const roots: string[] = [];

function makeEngine() {
  const database = new Database({ path: ":memory:" });
  databases.push(database);
  return new Engine({ database, environment });
}

function command(commandId: string, input: Parameters<Engine["dispatch"]>[0]["command"]) {
  return { protocolVersion: 1 as const, commandId: CommandId.parse(commandId), command: input };
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "zli-reactor-"));
  roots.push(root);
  const repoPath = join(root, "repo");
  const workspaceRoot = join(root, "worktrees");
  await mkdir(repoPath);
  await mkdir(workspaceRoot);
  await writeFile(join(repoPath, "README.md"), "initial\n");
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "zli-tests@example.invalid"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "ZLI Tests"], { cwd: repoPath });
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoPath });
  return { repoPath, workspaceRoot };
}

afterEach(async () => {
  for (const reactor of reactors.splice(0)) reactor.stop();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function recordingGit() {
  const git = new GitProcess();
  const calls: string[][] = [];
  return {
    calls,
    run: (args: readonly string[], options: Parameters<GitProcess["run"]>[1]) => {
      calls.push([...args]);
      return git.run(args, options);
    },
  };
}

async function importCheckout(engine: Engine, repoPath: string, worktreeId: WorktreeId, suffix: string) {
  const projectReceipt = await engine.dispatchPromise(
    command(`00000000-0000-4000-8000-0000000003${suffix}`, { type: "project.register", path: repoPath }),
  );
  const projectId = ProjectId.parse(projectReceipt.result?.projectId ?? "");
  const imported = await engine.dispatchPromise(
    command(`00000000-0000-4000-8000-0000000004${suffix}`, {
      type: "worktree.import",
      worktreeId,
      projectId,
      path: repoPath,
      branch: "HEAD",
      kind: "checkout",
    }),
  );
  expect(imported.status).toBe("accepted");
}

describe("project checkout placement", () => {
  it("replaces the placeholder branch with the checkout's real branch", async () => {
    const root = await createRepository();
    const engine = makeEngine();
    const reactor = new WorktreeReactor(engine, new WorktreeService(new GitProcess()));
    reactors.push(reactor);
    const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000301");

    await importCheckout(engine, root.repoPath, worktreeId, "01");
    await reactor.waitForIdle();

    expect((await engine.projection()).worktrees).toMatchObject([
      { worktreeId, kind: "checkout", status: "ready", branch: "main", path: root.repoPath },
    ]);
  });

  it("marks the checkout failed when git cannot read its branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "zli-not-a-repo-"));
    roots.push(root);
    const engine = makeEngine();
    const reactor = new WorktreeReactor(
      engine,
      new WorktreeService({
        async run(args) {
          throw new GitProcessError(
            `git ${args.join(" ")} exited with code 128.`,
            128,
            args,
            "",
            "fatal: not a git repository",
          );
        },
      }),
    );
    reactors.push(reactor);
    const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000302");

    await importCheckout(engine, root, worktreeId, "02");
    await reactor.waitForIdle();

    const worktree = (await engine.projection()).worktrees[0];
    expect(worktree?.status).toBe("failed");
    expect(worktree?.errorMessage).toContain("rev-parse");
  });

  it("forgets a removed checkout without running git worktree remove or deleting files", async () => {
    const root = await createRepository();
    const engine = makeEngine();
    const git = recordingGit();
    const reactor = new WorktreeReactor(engine, new WorktreeService(git));
    reactors.push(reactor);
    const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000303");
    await importCheckout(engine, root.repoPath, worktreeId, "03");
    await reactor.waitForIdle();

    await engine.dispatchPromise(
      command("00000000-0000-4000-8000-000000000503", { type: "worktree.remove", worktreeId, force: true }),
    );
    await reactor.waitForIdle();

    expect((await engine.projection()).worktrees).toEqual([]);
    expect(git.calls.some((args) => args[0] === "worktree")).toBe(false);
    await expect(readFile(join(root.repoPath, "README.md"), "utf8")).resolves.toBe("initial\n");
  });

  it("archives a checkout without touching disk", async () => {
    const root = await createRepository();
    const engine = makeEngine();
    const git = recordingGit();
    const reactor = new WorktreeReactor(engine, new WorktreeService(git));
    reactors.push(reactor);
    const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000304");
    await importCheckout(engine, root.repoPath, worktreeId, "04");
    await reactor.waitForIdle();

    await engine.dispatchPromise(
      command("00000000-0000-4000-8000-000000000504", { type: "worktree.archive", worktreeId }),
    );
    await reactor.waitForIdle();

    expect((await engine.projection()).worktrees).toEqual([]);
    expect(git.calls.every((args) => args[0] === "rev-parse")).toBe(true);
    await expect(readFile(join(root.repoPath, "README.md"), "utf8")).resolves.toBe("initial\n");
  });
});

describe("durable worktree reactor", () => {
  it("materializes a requested worktree after the intent event commits", async () => {
    const root = await createRepository();
    const engine = makeEngine();
    const reactor = new WorktreeReactor(engine, new WorktreeService(new GitProcess()));
    reactors.push(reactor);
    const projectReceipt = await engine.dispatchPromise(
      command("00000000-0000-4000-8000-000000000202", {
        type: "project.register",
        path: root.repoPath,
      }),
    );
    const projectId = ProjectId.parse(projectReceipt.result?.projectId ?? "");
    const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000203");
    const worktreePath = join(root.workspaceRoot, "feature-reactor");

    await engine.dispatchPromise(
      command("00000000-0000-4000-8000-000000000204", {
        type: "worktree.create",
        worktreeId,
        projectId,
        path: worktreePath,
        workspaceRoot: root.workspaceRoot,
        branch: "feature/reactor",
        baseRef: "main",
      }),
    );
    await reactor.waitForIdle();

    expect((await engine.projection()).worktrees).toMatchObject([
      { worktreeId, status: "ready", branch: "feature/reactor" },
    ]);
    await expect(
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath }),
    ).resolves.toMatchObject({
      stdout: "feature/reactor\n",
    });
  });

  it("removes a worktree together with its unmerged branch when asked", async () => {
    const root = await createRepository();
    const engine = makeEngine();
    const reactor = new WorktreeReactor(engine, new WorktreeService(new GitProcess()));
    reactors.push(reactor);
    const projectReceipt = await engine.dispatchPromise(
      command("00000000-0000-4000-8000-000000000211", { type: "project.register", path: root.repoPath }),
    );
    const projectId = ProjectId.parse(projectReceipt.result?.projectId ?? "");
    const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000212");
    const worktreePath = join(root.workspaceRoot, "main-run2");
    await engine.dispatchPromise(
      command("00000000-0000-4000-8000-000000000213", {
        type: "worktree.create",
        worktreeId,
        projectId,
        path: worktreePath,
        workspaceRoot: root.workspaceRoot,
        branch: "main-run2",
        baseRef: "main",
      }),
    );
    await reactor.waitForIdle();
    await writeFile(join(worktreePath, "run.txt"), "run work\n");
    await execFileAsync("git", ["add", "run.txt"], { cwd: worktreePath });
    await execFileAsync("git", ["commit", "-m", "run work"], { cwd: worktreePath });
    await writeFile(join(worktreePath, "dirty.txt"), "not committed\n");

    await engine.dispatchPromise(
      command("00000000-0000-4000-8000-000000000214", {
        type: "worktree.remove",
        worktreeId,
        force: true,
        deleteBranch: true,
      }),
    );
    await reactor.waitForIdle();

    expect((await engine.projection()).worktrees).toEqual([]);
    const branches = await execFileAsync("git", ["branch", "--list", "main-run2"], { cwd: root.repoPath });
    expect(branches.stdout.trim()).toBe("");
  });

  it("records bootstrap failures while leaving the committed worktree intent reviewable", async () => {
    const root = await createRepository();
    const engine = makeEngine();
    const service = new WorktreeService(new GitProcess());
    const reactor = new WorktreeReactor(engine, service, {
      bootstrap: async () => {
        throw new Error("bootstrap failed");
      },
    });
    reactors.push(reactor);
    const projectReceipt = await engine.dispatchPromise(
      command("00000000-0000-4000-8000-000000000205", {
        type: "project.register",
        path: root.repoPath,
      }),
    );
    const projectId = ProjectId.parse(projectReceipt.result?.projectId ?? "");
    await engine.dispatchPromise(
      command("00000000-0000-4000-8000-000000000207", {
        type: "worktree.create",
        worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000206"),
        projectId,
        path: join(root.workspaceRoot, "failed"),
        workspaceRoot: root.workspaceRoot,
        branch: "feature/failed",
      }),
    );
    await reactor.waitForIdle();

    expect((await engine.projection()).worktrees[0]?.status).toBe("failed");
    expect((await engine.projection()).worktrees[0]?.errorMessage).toContain("bootstrap failed");
  });

  it("records a clear lock message when git cannot create the worktree", async () => {
    const root = await createRepository();
    const engine = makeEngine();
    const reactor = new WorktreeReactor(
      engine,
      new WorktreeService({
        async run() {
          throw new GitProcessError(
            "git worktree add exited with code 128.",
            128,
            ["worktree", "add"],
            "",
            "fatal: Unable to create '/repo/.git/index.lock': File exists.\n",
          );
        },
      }),
    );
    reactors.push(reactor);
    const projectReceipt = await engine.dispatchPromise(
      command("00000000-0000-4000-8000-000000000208", {
        type: "project.register",
        path: root.repoPath,
      }),
    );
    const projectId = ProjectId.parse(projectReceipt.result?.projectId ?? "");
    await engine.dispatchPromise(
      command("00000000-0000-4000-8000-000000000209", {
        type: "worktree.create",
        worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000210"),
        projectId,
        path: join(root.workspaceRoot, "locked"),
        workspaceRoot: root.workspaceRoot,
        branch: "feature/locked",
      }),
    );
    await reactor.waitForIdle();

    const worktree = (await engine.projection()).worktrees[0];
    expect(worktree?.status).toBe("failed");
    expect(worktree?.errorMessage).toContain("lock is held");
    expect(worktree?.errorMessage).toContain("index.lock");
  });
});
