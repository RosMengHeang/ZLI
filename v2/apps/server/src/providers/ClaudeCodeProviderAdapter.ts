import type { ProviderCapabilities, ThreadId } from "@zli-v2/contracts";
import type { ClaudeCodeClient, ClaudeProviderEvent } from "@zli-v2/provider-claude-code";
import { ClaudeProviderError } from "@zli-v2/provider-claude-code";

import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderSession,
  ProviderSessionStart,
  ProviderTurnInput,
} from "./ProviderService.js";
import { toolActivity } from "./toolActivity.js";

type ClaudeClient = Pick<ClaudeCodeClient, "sendTurn" | "interruptTurn" | "transcript" | "subscribe" | "close"> &
  Partial<Pick<ClaudeCodeClient, "respondToApproval">>;
type ClientStart = Pick<ProviderSessionStart, "cwd" | "permissionMode" | "model" | "worktreeId">;

export class ClaudeCodeProviderAdapter implements ProviderAdapter {
  readonly provider = "claude-code" as const;
  readonly capabilities: ProviderCapabilities = {
    exactResume: false,
    structuredApproval: true,
    structuredUserInput: false,
    conversationRollback: false,
    modelSwitch: "in-session",
  };

  private readonly sessions = new Map<
    string,
    { session: ProviderSession; client: ClaudeClient; unsubscribe: () => void }
  >();
  private readonly listeners = new Set<(event: ProviderEvent) => void>();

  constructor(private readonly options: { createClient: (input: ClientStart) => Promise<ClaudeClient> }) {}

  async startSession(input: ProviderSessionStart): Promise<ProviderSession> {
    const client = await this.options.createClient({
      cwd: input.cwd,
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
    });
    const session: ProviderSession = {
      threadId: input.threadId,
      provider: this.provider,
      cwd: input.cwd,
      status: "idle",
    };
    const unsubscribe = client.subscribe((event) => this.onClaudeEvent(input.threadId, input.cwd, event));
    this.sessions.set(input.threadId, { session, client, unsubscribe });
    return session;
  }

  async sendTurn(input: ProviderTurnInput): Promise<{ turnId: string }> {
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
    const context = this.context(input.threadId);
    if (!context.client.respondToApproval) {
      throw new ClaudeProviderError("unsupported", "Claude Code adapter does not handle structured approvals.");
    }
    await context.client.respondToApproval(input.requestId, approvalAllowed(input.decision), {
      forSession: approvalForSession(input.decision),
    });
  }

  async respondToUserInput(input: {
    threadId: ThreadId;
    requestId: string;
    answers: Record<string, string>;
  }): Promise<void> {
    this.context(input.threadId);
    throw new ClaudeProviderError("unsupported", "Claude Code adapter does not handle structured user input.");
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
    throw new ClaudeProviderError("unsupported", "Claude Code adapter does not support conversation rollback.");
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
    client: ClaudeClient;
    unsubscribe: () => void;
  } {
    const context = this.sessions.get(threadId);
    if (!context) throw new Error(`Claude Code session does not exist: ${threadId}`);
    return context;
  }

  private onClaudeEvent(threadId: ThreadId, cwd: string, event: ClaudeProviderEvent): void {
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
      case "usage.updated":
        this.emit({ type: "usage", threadId, turnId: event.providerTurnId, usage: event.usage });
        return;
      case "tool.updated":
        this.emit({
          type: "activity",
          threadId,
          turnId: event.providerTurnId,
          activity: toolActivity(event.tool, cwd),
        });
        return;
      case "approval.requested":
        this.emit({ type: "approval.requested", threadId, requestId: event.requestId, payload: event.payload });
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

/** The UI answers approvals with { approved }; Codex-style { decision: "accept" } is accepted too. */
export function approvalAllowed(decision: unknown): boolean {
  if (decision === true) return true;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return false;
  const record = decision as Record<string, unknown>;
  if (typeof record.approved === "boolean") return record.approved;
  return (
    record.decision === "accept" ||
    record.decision === "acceptForSession" ||
    record.decision === "allow" ||
    record.decision === "approved"
  );
}

/** { approved: true, scope: "session" } or Codex-style "acceptForSession" keeps allowing the same tool. */
export function approvalForSession(decision: unknown): boolean {
  if (!approvalAllowed(decision) || !decision || typeof decision !== "object") return false;
  const record = decision as Record<string, unknown>;
  return record.scope === "session" || record.decision === "acceptForSession";
}
