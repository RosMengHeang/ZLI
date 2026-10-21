import { randomUUID } from "node:crypto";

import {
  CommandId,
  ProjectId,
  type RuntimeCommand,
  type RuntimeEventEnvelope,
  type SetupDecision,
  TerminalId,
  WorktreeId,
  type WorktreeSetupProjection,
} from "@zli-v2/contracts";

import type { Engine } from "../orchestration/Engine.js";
import type { TerminalService } from "../terminal/TerminalService.js";
import { copyIntoWorktree } from "./WorktreeCopy.js";
import { readZliConfig } from "./zliConfig.js";

export type WorktreeSetupContext = {
  worktreeId: string;
  projectId: string;
  repoPath: string;
  worktreePath: string;
  signal: AbortSignal;
};

type TerminalOutcome = { kind: "exited"; code: number } | { kind: "failed"; message: string };

/**
 * Agents queued for the worktree wait while setup does, so an unanswered prompt cannot hold them
 * forever. Unanswered commands are skipped rather than run, because nobody approved them.
 */
export const SETUP_APPROVAL_TIMEOUT_MS = 10 * 60_000;

export type WorktreeSetupOptions = { approvalTimeoutMs?: number };

/** The shell a setup command runs in. A login shell on Unix so PATH matches the person's terminal. */
export function setupShell(command: string, platform: NodeJS.Platform = process.platform) {
  return platform === "win32"
    ? { shell: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-Command", command] }
    : { shell: "/bin/bash", args: ["-lc", command] };
}

/**
 * Copies zli.json files into a new worktree and runs its setup commands, each in a visible terminal.
 * Runs while the worktree is "bootstrapping", so agents queued for the worktree start after it.
 * Setup problems are reported on the setup record and never fail the worktree itself.
 */
export class WorktreeSetupRunner {
  private readonly decisions = new Map<string, (decision: SetupDecision) => void>();
  private readonly terminals = new Map<string, (outcome: TerminalOutcome) => void>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeExit: () => void;

  constructor(
    private readonly engine: Engine,
    terminalService: Pick<TerminalService, "subscribeExit">,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly options: WorktreeSetupOptions = {},
  ) {
    this.unsubscribe = engine.subscribe((envelope) => this.onEvent(envelope));
    this.unsubscribeExit = terminalService.subscribeExit((terminalId, event) => {
      this.terminals.get(terminalId)?.({ kind: "exited", code: event.code });
    });
  }

  stop(): void {
    this.unsubscribe();
    this.unsubscribeExit();
  }

  /** Setup that was in flight when ZLI stopped cannot resume; it is marked failed and the worktree released. */
  async reconcile(): Promise<void> {
    const projection = await this.engine.projection();
    for (const setup of projection.worktreeSetups ?? []) {
      if (setup.status !== "copying" && setup.status !== "waiting" && setup.status !== "running") continue;
      await this.report({ ...setup, status: "failed", errorMessage: "ZLI closed before setup finished." });
      const worktree = projection.worktrees.find((entry) => entry.worktreeId === setup.worktreeId);
      if (worktree?.status === "bootstrapping") {
        await this.dispatch({ type: "worktree.status", worktreeId: worktree.worktreeId, status: "ready" });
      }
    }
  }

  async run(context: WorktreeSetupContext): Promise<void> {
    const config = await readZliConfig(context.repoPath);
    if (config.status === "missing") return;
    const base = {
      worktreeId: WorktreeId.parse(context.worktreeId),
      projectId: ProjectId.parse(context.projectId),
      commands: [] as string[],
      commandsHash: "",
      copied: [] as string[],
      skipped: [] as WorktreeSetupProjection["skipped"],
    };
    if (config.status === "invalid") {
      await this.report({ ...base, status: "invalid", errorMessage: config.message });
      return;
    }
    const commands = config.config.worktree?.setup ?? [];
    const patterns = config.config.worktree?.copy ?? [];
    if (commands.length === 0 && patterns.length === 0) return;
    let setup: WorktreeSetupProjection = {
      ...base,
      status: "copying",
      commands,
      commandsHash: config.commandsHash ?? "",
    };
    await this.report(setup);
    try {
      const copy = await copyIntoWorktree({ repoPath: context.repoPath, worktreePath: context.worktreePath, patterns });
      setup = { ...setup, copied: copy.copied, skipped: copy.skipped };
    } catch (error) {
      await this.report({ ...setup, status: "failed", errorMessage: `Copying files failed: ${messageOf(error)}` });
      return;
    }
    if (commands.length === 0) {
      await this.report({ ...setup, status: "succeeded" });
      return;
    }
    if (!(await this.trusted(setup))) {
      setup = { ...setup, status: "waiting" };
      const decision = await this.waitForDecision(setup, context.signal);
      if (decision === "timed-out") {
        const minutes = Math.max(1, Math.round(this.approvalTimeoutMs / 60_000));
        await this.report({
          ...setup,
          status: "skipped",
          errorMessage: `Setup was skipped because nobody approved the commands within ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        });
        return;
      }
      if (decision === "skip") {
        await this.report({ ...setup, status: "skipped" });
        return;
      }
    }
    for (const [index, command] of commands.entries()) {
      const terminalId = TerminalId.parse(randomUUID());
      setup = { ...setup, status: "running", commandIndex: index, terminalId };
      await this.report(setup);
      const outcome = await this.runCommand(context, terminalId, command, index, commands.length);
      if (outcome.kind === "failed") {
        await this.report({ ...setup, status: "failed", errorMessage: outcome.message });
        return;
      }
      if (outcome.code !== 0) {
        await this.report({
          ...setup,
          status: "failed",
          exitCode: outcome.code,
          errorMessage: `Setup command ${index + 1} of ${commands.length} exited with code ${outcome.code}: ${command}`,
        });
        return;
      }
    }
    const { commandIndex: _index, terminalId: _terminal, ...done } = setup;
    await this.report({ ...done, status: "succeeded" });
  }

  private onEvent(envelope: RuntimeEventEnvelope): void {
    const event = envelope.event;
    if (event.type === "worktree.setup.responded") {
      this.decisions.get(event.worktreeId)?.(event.decision);
    } else if (event.type === "terminal.status.changed" && event.status === "failed") {
      this.terminals.get(event.terminalId)?.({
        kind: "failed",
        message: event.errorMessage ?? "The setup terminal could not start.",
      });
    }
  }

  private async trusted(setup: WorktreeSetupProjection): Promise<boolean> {
    const projection = await this.engine.projection();
    return (projection.setupTrust ?? []).some(
      (trust) => trust.projectId === setup.projectId && trust.commandsHash === setup.commandsHash,
    );
  }

  private get approvalTimeoutMs(): number {
    return this.options.approvalTimeoutMs ?? SETUP_APPROVAL_TIMEOUT_MS;
  }

  private async waitForDecision(
    setup: WorktreeSetupProjection,
    signal: AbortSignal,
  ): Promise<SetupDecision | "timed-out"> {
    const decision = new Promise<SetupDecision | "timed-out">((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.decisions.delete(setup.worktreeId);
      };
      const onAbort = () => {
        settle();
        reject(abortError());
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      this.decisions.set(setup.worktreeId, (value) => {
        settle();
        resolve(value);
      });
      timer = setTimeout(() => {
        settle();
        resolve("timed-out");
      }, this.approvalTimeoutMs);
    });
    // The waiter is registered before the record is published, so an instant answer is not missed.
    await this.report(setup);
    return decision;
  }

  private async runCommand(
    context: WorktreeSetupContext,
    terminalId: TerminalId,
    command: string,
    index: number,
    total: number,
  ): Promise<TerminalOutcome> {
    const outcome = new Promise<TerminalOutcome>((resolve, reject) => {
      const finish = () => {
        this.terminals.delete(terminalId);
        context.signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        finish();
        void this.dispatch({ type: "terminal.stop", terminalId }).catch(() => undefined);
        reject(abortError());
      };
      if (context.signal.aborted) return onAbort();
      context.signal.addEventListener("abort", onAbort, { once: true });
      this.terminals.set(terminalId, (value) => {
        finish();
        resolve(value);
      });
    });
    const { shell, args } = setupShell(command, this.platform);
    const receipt = await this.dispatch({
      type: "terminal.create",
      terminalId,
      worktreeId: WorktreeId.parse(context.worktreeId),
      cwd: context.worktreePath,
      shell,
      args,
      title: total > 1 ? `Setup ${index + 1}/${total}` : "Setup",
      cols: 120,
      rows: 32,
    });
    if (receipt.status === "rejected") {
      this.terminals.get(terminalId)?.({ kind: "failed", message: receipt.error?.message ?? "Setup could not start." });
    }
    return outcome;
  }

  private report(setup: WorktreeSetupProjection): Promise<unknown> {
    return this.dispatch({ type: "worktree.setup", setup });
  }

  private dispatch(command: RuntimeCommand) {
    return this.engine.dispatchPromise({ protocolVersion: 1, commandId: CommandId.parse(randomUUID()), command });
  }
}

function abortError(): Error {
  const error = new Error("Worktree setup was cancelled.");
  error.name = "AbortError";
  return error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
