import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
