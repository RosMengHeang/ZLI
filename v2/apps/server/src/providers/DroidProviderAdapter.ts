import type { ProviderCapabilities, ThreadId } from "@zli-v2/contracts";
import type { DroidClient, DroidProviderEvent } from "@zli-v2/provider-droid";
import { DroidProviderError } from "@zli-v2/provider-droid";

import type { ProviderAdapter, ProviderEvent, ProviderSession } from "./ProviderService.js";

type DroidSessionClient = Pick<DroidClient, "sendTurn" | "interruptTurn" | "transcript" | "subscribe" | "close">;

export class DroidProviderAdapter implements ProviderAdapter {
  readonly provider = "droid" as const;
  readonly capabilities: ProviderCapabilities = {
    exactResume: false,
    structuredApproval: false,
    structuredUserInput: false,
    conversationRollback: false,
    modelSwitch: "unsupported",
  };

  private readonly sessions = new Map<
    string,
    { session: ProviderSession; client: DroidSessionClient; unsubscribe: () => void }
  >();
  private readonly listeners = new Set<(event: ProviderEvent) => void>();

  constructor(private readonly options: { createClient: (input: { cwd: string }) => Promise<DroidSessionClient> }) {}

  async startSession(input: { threadId: ThreadId; cwd: string }): Promise<ProviderSession> {
    const client = await this.options.createClient({ cwd: input.cwd });
    const session: ProviderSession = {
      threadId: input.threadId,
      provider: this.provider,
      cwd: input.cwd,
      status: "idle",
    };
    const unsubscribe = client.subscribe((event) => this.onDroidEvent(input.threadId, event));
    this.sessions.set(input.threadId, { session, client, unsubscribe });
    return session;
  }

  async sendTurn(input: { threadId: ThreadId; text: string; model?: string }): Promise<{ turnId: string }> {
    const context = this.context(input.threadId);
    const result = await context.client.sendTurn({
      text: input.text,
      ...(input.model ? { model: input.model } : {}),
    });
    return { turnId: result.providerTurnId };
  }

  async interruptTurn(input: { threadId: ThreadId; turnId?: string }): Promise<void> {
    const context = this.context(input.threadId);
    await context.client.interruptTurn(input.turnId);
  }

  async respondToRequest(input: { threadId: ThreadId; requestId: string; decision: unknown }): Promise<void> {
    this.context(input.threadId);
    throw new DroidProviderError("unsupported", "Droid CLI adapter does not handle structured approvals.");
  }

  async respondToUserInput(input: {
    threadId: ThreadId;
    requestId: string;
    answers: Record<string, string>;
  }): Promise<void> {
    this.context(input.threadId);
    throw new DroidProviderError("unsupported", "Droid CLI adapter does not handle structured user input.");
  }

  async stopSession(input: { threadId: ThreadId }): Promise<void> {
    const context = this.context(input.threadId);
    this.sessions.delete(input.threadId);
    context.unsubscribe();
    await context.client.close();
  }

  listSessions(): ReadonlyArray<ProviderSession> {
    return [...this.sessions.values()].map((context) => context.session);
  }

  hasSession(input: { threadId: ThreadId }): boolean {
    return this.sessions.has(input.threadId);
  }

  async readThread(input: { threadId: ThreadId }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    const context = this.context(input.threadId);
    return { threadId: input.threadId, turns: context.client.transcript() };
  }

  async rollbackThread(input: {
    threadId: ThreadId;
    numTurns: number;
  }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    this.context(input.threadId);
    throw new DroidProviderError("unsupported", "Droid CLI adapter does not support conversation rollback.");
  }

  async stopAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map(async (context) => {
        context.unsubscribe();
        await context.client.close();
      }),
    );
  }

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private context(threadId: ThreadId): {
    session: ProviderSession;
    client: DroidSessionClient;
    unsubscribe: () => void;
  } {
    const context = this.sessions.get(threadId);
    if (!context) throw new Error(`Droid CLI session does not exist: ${threadId}`);
    return context;
  }

  private onDroidEvent(threadId: ThreadId, event: DroidProviderEvent): void {
    switch (event.type) {
      case "turn.started":
        this.emit({ type: "turn.started", threadId, turnId: event.providerTurnId });
        return;
      case "assistant.delta":
        this.emit({ type: "assistant.delta", threadId, turnId: event.providerTurnId, text: event.text });
        return;
      case "turn.completed":
        this.emit({ type: "turn.completed", threadId, turnId: event.providerTurnId, status: event.status });
        return;
      case "turn.failed":
        this.emit({ type: "provider.error", threadId, message: event.message });
        return;
      case "session.closed":
        this.dropSession(threadId);
        this.emit({ type: "session.closed", threadId, reason: event.reason });
        return;
      case "protocol.error":
        this.emit({ type: "provider.error", message: event.message });
        return;
      default:
        return;
    }
  }

  private dropSession(threadId: ThreadId): void {
    const context = this.sessions.get(threadId);
    if (!context) return;
    this.sessions.delete(threadId);
    context.unsubscribe();
    void context.client.close();
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
