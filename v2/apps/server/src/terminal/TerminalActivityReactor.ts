import { randomUUID } from "node:crypto";

import { CommandId, type TerminalActivity, type TerminalId } from "@zli-v2/contracts";

import type { Engine } from "../orchestration/Engine.js";

type TerminalActivitySource = {
  subscribeOutput(listener: (terminalId: TerminalId, data: string) => void): () => void;
  subscribeInput(listener: (terminalId: TerminalId) => void): () => void;
  subscribeExit(listener: (terminalId: TerminalId) => void): () => void;
};

export type TerminalActivityOptions = {
  /** Output that keeps coming for this long means the agent is at work. A single redraw is over well within it. */
  sustainMs?: number;
  /** A gap this long ends a run of output, so the next output starts counting again. */
  burstGapMs?: number;
  /** Quiet for this long means the agent stopped. Long enough to ride over a pause between spinner frames. */
  quietMs?: number;
  /** Output this soon after a keystroke or a resize is the terminal answering it, not the agent working. */
  inputGraceMs?: number;
  now?: () => number;
};

type Watch = {
  working: boolean;
  lastInput: number;
  burstStart: number | undefined;
  lastOutput: number | undefined;
  quiet: ReturnType<typeof setTimeout> | undefined;
};

/**
 * Tells when an agent CLI in a terminal is working. A terminal only says whether its process runs, so this
 * reads the output instead: every agent CLI redraws a spinner and a timer while it works (Claude Code,
 * Codex, Cursor, Droid, OpenCode, Gemini) and goes quiet once it is done. It needs nothing from the CLI,
 * so every harness gets it, including one with no tile on screen.
 */
export class TerminalActivityReactor {
  private readonly watches = new Map<string, Watch>();
  private readonly agents = new Map<string, Promise<boolean>>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly unsubscribe: Array<() => void>;
  private readonly sustainMs: number;
  private readonly burstGapMs: number;
  private readonly quietMs: number;
  private readonly inputGraceMs: number;
  private readonly now: () => number;

  constructor(
    private readonly engine: Engine,
    terminals: TerminalActivitySource,
    options: TerminalActivityOptions = {},
  ) {
    this.sustainMs = options.sustainMs ?? 700;
    this.burstGapMs = options.burstGapMs ?? 1_000;
    this.quietMs = options.quietMs ?? 3_000;
    this.inputGraceMs = options.inputGraceMs ?? 1_500;
    this.now = options.now ?? Date.now;
    this.unsubscribe = [
      terminals.subscribeOutput((terminalId, data) => this.output(terminalId, data)),
      terminals.subscribeInput((terminalId) => {
        this.watch(terminalId).lastInput = this.now();
      }),
      terminals.subscribeExit((terminalId) => this.forget(terminalId)),
    ];
    // A restart loses track of what each agent was doing, so none is left looking busy. Output marks it again.
    this.track(this.settleStale());
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    for (const watch of this.watches.values()) clearTimeout(watch.quiet);
    this.watches.clear();
  }

  async waitForIdle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.all([...this.tasks]);
    await this.engine.projection();
  }

  private output(terminalId: TerminalId, data: string): void {
    if (data.length === 0) return;
    const watch = this.watch(terminalId);
    const now = this.now();
    if (watch.working) {
      // Typing into a busy agent echoes too; it stays working until the output stops.
      watch.lastOutput = now;
      this.armQuiet(terminalId, watch);
      return;
    }
    if (now - watch.lastInput < this.inputGraceMs) {
      watch.burstStart = undefined;
      watch.lastOutput = undefined;
      return;
    }
    if (watch.lastOutput === undefined || now - watch.lastOutput > this.burstGapMs) watch.burstStart = now;
    watch.lastOutput = now;
    this.armQuiet(terminalId, watch);
    if (watch.burstStart !== undefined && now - watch.burstStart >= this.sustainMs) {
      watch.working = true;
      this.track(this.set(terminalId, "working"));
    }
  }

  private armQuiet(terminalId: TerminalId, watch: Watch): void {
    clearTimeout(watch.quiet);
    watch.quiet = setTimeout(() => {
      watch.quiet = undefined;
      watch.burstStart = undefined;
      watch.lastOutput = undefined;
      if (!watch.working) return;
      watch.working = false;
      this.track(this.set(terminalId, "idle"));
    }, this.quietMs);
    watch.quiet.unref?.();
  }

  private watch(terminalId: TerminalId): Watch {
    let watch = this.watches.get(terminalId);
    if (!watch) {
      watch = {
        working: false,
        lastInput: Number.NEGATIVE_INFINITY,
        burstStart: undefined,
        lastOutput: undefined,
        quiet: undefined,
      };
      this.watches.set(terminalId, watch);
    }
    return watch;
  }

  private forget(terminalId: TerminalId): void {
    clearTimeout(this.watches.get(terminalId)?.quiet);
    this.watches.delete(terminalId);
    this.agents.delete(terminalId);
  }

  /** Shells print for all kinds of reasons, so only agent terminals are watched. */
  private isAgent(terminalId: TerminalId): Promise<boolean> {
    let known = this.agents.get(terminalId);
    if (!known) {
      known = this.engine
        .projection()
        .then((projection) =>
          projection.terminals.some((terminal) => terminal.terminalId === terminalId && terminal.kind === "agent"),
        );
      this.agents.set(terminalId, known);
    }
    return known;
  }

  private async set(terminalId: TerminalId, activity: TerminalActivity): Promise<void> {
    if (!(await this.isAgent(terminalId))) return;
    await this.dispatch(terminalId, activity);
  }

  private async settleStale(): Promise<void> {
    const projection = await this.engine.projection();
    for (const terminal of projection.terminals) {
      if (terminal.activity === "working" && !this.watches.get(terminal.terminalId)?.working) {
        await this.dispatch(terminal.terminalId, "idle");
      }
    }
  }

  private async dispatch(terminalId: TerminalId, activity: TerminalActivity): Promise<void> {
    // The terminal can end between its output and this command; that is not an error.
    await this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: { type: "terminal.activity", terminalId, activity },
      })
      .catch(() => undefined);
  }

  private track(task: Promise<void>): void {
    const tracked = task.catch(() => undefined);
    this.tasks.add(tracked);
    void tracked.then(() => this.tasks.delete(tracked));
  }
}
