import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommandId,
  type EnvironmentDescriptor,
  EnvironmentId,
  ProjectId,
  type TerminalId,
  WorktreeId,
} from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
import { setupShell, WorktreeSetupRunner } from "./WorktreeSetup.js";
import { setupCommandsHash } from "./zliConfig.js";

const environment: EnvironmentDescriptor = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000401"),
  label: "Setup test environment",
  protocolVersion: 1,
  capabilities: { eventReplay: true, worktrees: true },
};
const cleanups: Array<() => unknown> = [];
let commandCounter = 0;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function command(input: Parameters<Engine["dispatch"]>[0]["command"]) {
  commandCounter += 1;
  return {
    protocolVersion: 1 as const,
    commandId: CommandId.parse(`00000000-0000-4000-9000-${String(commandCounter).padStart(12, "0")}`),
    command: input,
  };
}

/** Exits every setup terminal with the code mapped from its command, or 0. */
function fakeTerminals(engine: Engine, exitCodes: Record<string, number> = {}) {
  const listeners = new Set<(terminalId: TerminalId, event: { code: number; signal: number | null }) => void>();
  const started: string[] = [];
  const unsubscribe = engine.subscribe((envelope) => {
    const event = envelope.event;
    if (event.type !== "terminal.create.requested") return;
    const script = event.args?.at(-1) ?? "";
    started.push(script);
    setTimeout(() => {
      for (const listener of listeners)
        listener(event.terminal.terminalId, { code: exitCodes[script] ?? 0, signal: null });
    }, 0);
  });
  cleanups.push(unsubscribe);
  return {
    started,
    service: {
      subscribeExit(listener: (terminalId: TerminalId, event: { code: number; signal: number | null }) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

async function setupFixture(config: unknown) {
  const root = await mkdtemp(join(tmpdir(), "zli-setup-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repoPath = join(root, "repo");
  const worktreePath = join(root, "worktree");
  await mkdir(repoPath);
  await mkdir(worktreePath);
  await writeFile(join(repoPath, "zli.json"), typeof config === "string" ? config : JSON.stringify(config));
  const database = new Database({ path: ":memory:" });
  cleanups.push(() => database.close());
  const engine = new Engine({ database, environment });
  const project = await engine.dispatchPromise(command({ type: "project.register", path: repoPath }));
  const projectId = ProjectId.parse(project.result?.projectId ?? "");
  const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000411");
  await engine.dispatchPromise(
    command({ type: "worktree.import", worktreeId, projectId, path: worktreePath, branch: "feature" }),
  );
  return { engine, repoPath, worktreePath, projectId, worktreeId };
}

function startRunner(engine: Engine, terminals: ReturnType<typeof fakeTerminals>, approvalTimeoutMs?: number) {
  const runner = new WorktreeSetupRunner(
    engine,
    terminals.service,
    "linux",
    approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs },
  );
  cleanups.push(() => runner.stop());
  return runner;
}

async function setupOf(engine: Engine, worktreeId: string) {
  return (await engine.projection()).worktreeSetups?.find((setup) => setup.worktreeId === worktreeId);
}

async function until(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the setup state.");
}

describe("worktree setup", () => {
  it("copies files, waits for approval, then runs each command in its own terminal", async () => {
    const fixture = await setupFixture({ version: 1, worktree: { copy: [".env"], setup: ["echo one", "echo two"] } });
    await writeFile(join(fixture.repoPath, ".env"), "KEY=1\n");
    const terminals = fakeTerminals(fixture.engine);
    const runner = startRunner(fixture.engine, terminals);
    const controller = new AbortController();

    const run = runner.run({ ...fixture, signal: controller.signal });
    await until(async () => (await setupOf(fixture.engine, fixture.worktreeId))?.status === "waiting");
    const waiting = await setupOf(fixture.engine, fixture.worktreeId);
    expect(waiting).toMatchObject({ copied: [".env"], commands: ["echo one", "echo two"] });
    expect(terminals.started).toEqual([]);

    const answer = await fixture.engine.dispatchPromise(
      command({
        type: "worktree.setup.respond",
        worktreeId: fixture.worktreeId,
        commandsHash: waiting?.commandsHash ?? "",
        decision: "run-once",
      }),
    );
    expect(answer.status).toBe("accepted");
    await run;

    expect(terminals.started).toEqual(["echo one", "echo two"]);
    expect(await setupOf(fixture.engine, fixture.worktreeId)).toMatchObject({ status: "succeeded" });
    await expect(readFile(join(fixture.worktreePath, ".env"), "utf8")).resolves.toBe("KEY=1\n");
    expect((await fixture.engine.projection()).setupTrust ?? []).toEqual([]);
    const titles = (await fixture.engine.projection()).terminals.map((terminal) => terminal.title);
    expect(titles).toEqual(["Setup 1/2", "Setup 2/2"]);
  });

  it("remembers 'always' for the exact command list and asks again when it changes", async () => {
    const fixture = await setupFixture({ version: 1, worktree: { setup: ["make"] } });
    const terminals = fakeTerminals(fixture.engine);
    const runner = startRunner(fixture.engine, terminals);
    const signal = new AbortController().signal;

    const first = runner.run({ ...fixture, signal });
    await until(async () => (await setupOf(fixture.engine, fixture.worktreeId))?.status === "waiting");
    await fixture.engine.dispatchPromise(
      command({
        type: "worktree.setup.respond",
        worktreeId: fixture.worktreeId,
        commandsHash: setupCommandsHash(["make"]),
        decision: "always",
      }),
    );
    await first;
    expect((await fixture.engine.projection()).setupTrust).toMatchObject([
      { projectId: fixture.projectId, commandsHash: setupCommandsHash(["make"]) },
    ]);

    await runner.run({ ...fixture, signal });
    expect(terminals.started).toEqual(["make", "make"]);

    await writeFile(
      join(fixture.repoPath, "zli.json"),
      JSON.stringify({ version: 1, worktree: { setup: ["make all"] } }),
    );
    const changed = runner.run({ ...fixture, signal });
    await until(async () => (await setupOf(fixture.engine, fixture.worktreeId))?.status === "waiting");
    const stale = await fixture.engine.dispatchPromise(
      command({
        type: "worktree.setup.respond",
        worktreeId: fixture.worktreeId,
        commandsHash: setupCommandsHash(["make"]),
        decision: "always",
      }),
    );
    expect(stale.status).toBe("rejected");
    await fixture.engine.dispatchPromise(
      command({
        type: "worktree.setup.respond",
        worktreeId: fixture.worktreeId,
        commandsHash: setupCommandsHash(["make all"]),
        decision: "skip",
      }),
    );
    await changed;
    expect(await setupOf(fixture.engine, fixture.worktreeId)).toMatchObject({ status: "skipped" });
    expect(terminals.started).toEqual(["make", "make"]);
  });

  it("stops at the first failing command and names it with its exit code", async () => {
    const fixture = await setupFixture({ version: 1, worktree: { setup: ["ok", "broken", "never"] } });
    const terminals = fakeTerminals(fixture.engine, { broken: 3 });
    const runner = startRunner(fixture.engine, terminals);
    const hash = setupCommandsHash(["ok", "broken", "never"]);
    const first = runner.run({ ...fixture, signal: new AbortController().signal });
    await until(async () => (await setupOf(fixture.engine, fixture.worktreeId))?.status === "waiting");
    await fixture.engine.dispatchPromise(
      command({
        type: "worktree.setup.respond",
        worktreeId: fixture.worktreeId,
        commandsHash: hash,
        decision: "run-once",
      }),
    );
    await first;

    expect(terminals.started).toEqual(["ok", "broken"]);
    expect(await setupOf(fixture.engine, fixture.worktreeId)).toMatchObject({
      status: "failed",
      commandIndex: 1,
      exitCode: 3,
      errorMessage: "Setup command 2 of 3 exited with code 3: broken",
    });
  });

  it("reports an invalid zli.json without blocking or running anything", async () => {
    const fixture = await setupFixture({ version: 1, worktree: { setup: "make" } });
    const terminals = fakeTerminals(fixture.engine);
    const runner = startRunner(fixture.engine, terminals);

    await runner.run({ ...fixture, signal: new AbortController().signal });

    const setup = await setupOf(fixture.engine, fixture.worktreeId);
    expect(setup?.status).toBe("invalid");
    expect(setup?.errorMessage).toContain("worktree.setup");
    expect(terminals.started).toEqual([]);
  });

  it("gives up waiting when the worktree is cancelled", async () => {
    const fixture = await setupFixture({ version: 1, worktree: { setup: ["make"] } });
    const runner = startRunner(fixture.engine, fakeTerminals(fixture.engine));
    const controller = new AbortController();

    const run = runner.run({ ...fixture, signal: controller.signal });
    await until(async () => (await setupOf(fixture.engine, fixture.worktreeId))?.status === "waiting");
    controller.abort();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });

  it("skips the commands when nobody answers the approval in time", async () => {
    const fixture = await setupFixture({ version: 1, worktree: { setup: ["make"] } });
    const terminals = fakeTerminals(fixture.engine);
    const runner = startRunner(fixture.engine, terminals, 20);

    await runner.run({ ...fixture, signal: new AbortController().signal });

    const setup = await setupOf(fixture.engine, fixture.worktreeId);
    expect(setup?.status).toBe("skipped");
    expect(setup?.errorMessage).toContain("nobody approved");
    expect(terminals.started).toEqual([]);
    const late = await fixture.engine.dispatchPromise(
      command({
        type: "worktree.setup.respond",
        worktreeId: fixture.worktreeId,
        commandsHash: setup?.commandsHash ?? "",
        decision: "run-once",
      }),
    );
    expect(late.status).toBe("rejected");
  });

  it("marks setup left running by a previous run as failed and releases the worktree", async () => {
    const fixture = await setupFixture({ version: 1, worktree: { setup: ["make"] } });
    await fixture.engine.dispatchPromise(
      command({ type: "worktree.status", worktreeId: fixture.worktreeId, status: "bootstrapping" }),
    );
    await fixture.engine.dispatchPromise(
      command({
        type: "worktree.setup",
        setup: {
          worktreeId: fixture.worktreeId,
          projectId: fixture.projectId,
          status: "waiting",
          commands: ["make"],
          commandsHash: setupCommandsHash(["make"]),
          copied: [],
          skipped: [],
        },
      }),
    );
    const runner = startRunner(fixture.engine, fakeTerminals(fixture.engine));

    await runner.reconcile();

    const projection = await fixture.engine.projection();
    expect(projection.worktreeSetups?.[0]).toMatchObject({ status: "failed" });
    expect(projection.worktrees[0]?.status).toBe("ready");
  });

  it("runs commands in a login bash on Unix and PowerShell on Windows", () => {
    expect(setupShell("pnpm i", "darwin")).toEqual({ shell: "/bin/bash", args: ["-lc", "pnpm i"] });
    expect(setupShell("pnpm i", "win32")).toEqual({
      shell: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-Command", "pnpm i"],
    });
  });
});
