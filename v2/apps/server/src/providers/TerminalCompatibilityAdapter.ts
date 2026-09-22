import { randomUUID } from "node:crypto";

import type { ProviderCapabilities, ThreadId } from "@zli-v2/contracts";

import type { ProviderAdapter, ProviderEvent, ProviderKind, ProviderSession } from "./ProviderService.js";

export type TerminalProviderDiscovery = {
  provider: Exclude<ProviderKind, "codex">;
  command: string;
};

export type TerminalChild = {
  stdin: { write(data: string): void };
  stdout: { on(event: "data", listener: (chunk: string | Buffer) => void): void };
  stderr: { on(event: "data", listener: (chunk: string | Buffer) => void): void };
  once(event: "error" | "close", listener: (...args: unknown[]) => void): void;
  kill(): void;
};

export async function discoverTerminalProvider(input: {
  provider: Exclude<ProviderKind, "codex">;
  candidates: readonly string[];
  resolve(candidate: string): Promise<string | undefined>;
}): Promise<TerminalProviderDiscovery | undefined> {
  for (const candidate of input.candidates) {
    const command = await input.resolve(candidate);
    if (command) return { provider: input.provider, command };
  }
  return undefined;
}

export class TerminalCompatibilityAdapter implements ProviderAdapter {
  readonly capabilities: ProviderCapabilities = {
    exactResume: false,
    structuredApproval: false,
    structuredUserInput: false,
    conversationRollback: false,
    modelSwitch: "unsupported",
  };
  private readonly sessions = new Map<string, { session: ProviderSession; child: TerminalChild; turnId: string }>();
  private readonly listeners = new Set<(event: ProviderEvent) => void>();

  constructor(
    private readonly options: {
      provider: Exclude<ProviderKind, "codex">;
      command: string;
      args?: readonly string[];
      spawn(
        command: string,
        args: readonly string[],
        options: { cwd: string; shell: false; stdio: readonly ["pipe", "pipe", "pipe"] },
      ): TerminalChild;
    },
  ) {}

  get provider(): Exclude<ProviderKind, "codex"> {
    return this.options.provider;
  }

  async startSession(input: { threadId: ThreadId; cwd: string }): Promise<ProviderSession> {
    if (this.sessions.has(input.threadId))
      throw new Error(`Terminal provider session already exists: ${input.threadId}`);
    const child = this.options.spawn(this.options.command, this.options.args ?? [], {
      cwd: input.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session: ProviderSession = {
      threadId: input.threadId,
      provider: this.provider,
      cwd: input.cwd,
      status: "idle",
    };
    const context = { session, child, turnId: "" };
    this.sessions.set(input.threadId, context);
    child.stdout.on("data", (chunk) => {
      this.emit({
        type: "assistant.delta",
        threadId: input.threadId,
        turnId: context.turnId,
        text: Buffer.from(chunk).toString("utf8"),
      });
    });
    child.stderr.on("data", (chunk) => {
      const text = Buffer.from(chunk).toString("utf8");
      if (text) this.emit({ type: "provider.error", threadId: input.threadId, message: text });
    });
    child.once("error", (...args) =>
      this.emit({
        type: "provider.error",
        threadId: input.threadId,
        message: String(args[0] ?? "Terminal provider process failed."),
      }),
    );
    child.once("close", () => {
      this.sessions.delete(input.threadId);
      this.emit({ type: "session.closed", threadId: input.threadId, reason: "Terminal provider process exited." });
    });
    return session;
  }

  async sendTurn(input: { threadId: ThreadId; text: string }): Promise<{ turnId: string }> {
    const context = this.context(input.threadId);
    const turnId = randomUUID();
    context.turnId = turnId;
    context.child.stdin.write(`${input.text}\n`);
    return { turnId };
  }

  async interruptTurn(input: { threadId: ThreadId }): Promise<void> {
    this.context(input.threadId).child.kill();
  }

  async respondToRequest(): Promise<void> {
    throw new Error("Terminal providers do not expose structured approvals.");
  }

  async respondToUserInput(): Promise<void> {
    throw new Error("Terminal providers do not expose structured user input.");
  }

  async stopSession(input: { threadId: ThreadId }): Promise<void> {
    const context = this.context(input.threadId);
    context.child.kill();
    this.sessions.delete(input.threadId);
  }

  listSessions(): ReadonlyArray<ProviderSession> {
    return [...this.sessions.values()].map((context) => context.session);
  }

  hasSession(input: { threadId: ThreadId }): boolean {
    return this.sessions.has(input.threadId);
  }

  async readThread(input: { threadId: ThreadId }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    this.context(input.threadId);
    return { threadId: input.threadId, turns: [] };
  }

  async rollbackThread(): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    throw new Error("Terminal providers do not support conversation rollback.");
  }

  async stopAll(): Promise<void> {
    for (const context of this.sessions.values()) context.child.kill();
    this.sessions.clear();
  }

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private context(threadId: ThreadId): { session: ProviderSession; child: TerminalChild; turnId: string } {
    const context = this.sessions.get(threadId);
    if (!context) throw new Error(`Terminal provider session does not exist: ${threadId}`);
    return context;
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
