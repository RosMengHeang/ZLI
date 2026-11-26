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
  Partial<Pick<ClaudeCodeClient, "respondToApproval" | "respondToQuestions" | "sessionId">>;
type ClientStart = Pick<
  ProviderSessionStart,
  | "cwd"
  | "permissionMode"
  | "unattended"
  | "model"
  | "worktreeId"
  | "account"
  | "resumeSessionId"
  | "trustedProjectPath"
  | "title"
>;

export class ClaudeCodeProviderAdapter implements ProviderAdapter {
  readonly provider = "claude-code" as const;
  readonly capabilities: ProviderCapabilities = {
    exactResume: false,
    structuredApproval: true,
    // AskUserQuestion shows as a question card.
    structuredUserInput: true,
    conversationRollback: false,
    modelSwitch: "in-session",
    // Claude Code fixes its mode when it starts, so a change restarts it on the same conversation (see sendTurn).
    permissionSwitch: "in-session",
    // Claude Code runs /compact when it arrives as a message and reports a compact_boundary. Text after it
    // ("/compact keep the API decisions") steers the summary.
    compaction: "native",
    compactionInstructions: true,
  };

  private readonly sessions = new Map<
    string,
    { session: ProviderSession; client: ClaudeClient; unsubscribe: () => void; start: ClientStart }
  >();
  private readonly listeners = new Set<(event: ProviderEvent) => void>();

  constructor(private readonly options: { createClient: (input: ClientStart) => Promise<ClaudeClient> }) {}

  async startSession(input: ProviderSessionStart): Promise<ProviderSession> {
    const start: ClientStart = {
      cwd: input.cwd,
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.unattended ? { unattended: true } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
      ...(input.account ? { account: input.account } : {}),
      ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
      ...(input.trustedProjectPath ? { trustedProjectPath: input.trustedProjectPath } : {}),
      ...(input.title ? { title: input.title } : {}),
    };
    const client = await this.options.createClient(start);
    const session: ProviderSession = {
      threadId: input.threadId,
      provider: this.provider,
      cwd: input.cwd,
      status: "idle",
      ...(client.sessionId ? { providerSessionId: client.sessionId } : {}),
    };
    const unsubscribe = client.subscribe((event) => this.onClaudeEvent(input.threadId, input.cwd, event));
    this.sessions.set(input.threadId, { session, client, unsubscribe, start });
    return session;
  }

  async sendTurn(input: ProviderTurnInput): Promise<{ turnId: string }> {
    let context = this.context(input.threadId);
    if (input.permissionMode && input.permissionMode !== (context.start.permissionMode ?? "full-access")) {
      context = await this.restartInMode(input.threadId, input.permissionMode);
    }
    const result = await context.client.sendTurn({
      text: input.text,
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      fast: input.fast !== undefined,
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
    const context = this.context(input.threadId);
    if (!context.client.respondToQuestions) {
      throw new ClaudeProviderError("unsupported", "Claude Code adapter does not handle structured user input.");
    }
    await context.client.respondToQuestions(input.requestId, input.answers);
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
    start: ClientStart;
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
        this.emit({
          type: "provider.error",
          threadId,
          message: event.message,
          ...(event.usageLimit ? { usageLimit: event.usageLimit } : {}),
        });
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
      case "reasoning.delta":
        this.emit({
          type: "reasoning.delta",
          threadId,
          turnId: event.providerTurnId,
          reasoningId: event.reasoningId,
          text: event.text,
        });
        return;
      case "reasoning.completed":
        this.emit({
          type: "reasoning.completed",
          threadId,
          turnId: event.providerTurnId,
          reasoningId: event.reasoningId,
          ...(event.text ? { text: event.text } : {}),
        });
        return;
      case "approval.requested":
        this.emit({ type: "approval.requested", threadId, requestId: event.requestId, payload: event.payload });
        return;
      case "user-input.requested":
        this.emit({ type: "user-input.requested", threadId, requestId: event.requestId, payload: event.payload });
        return;
      case "session.identified": {
        const context = this.sessions.get(threadId);
        if (context) context.session = { ...context.session, providerSessionId: event.sessionId };
        this.emit({ type: "session.identified", threadId, providerSessionId: event.sessionId });
        return;
      }
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

  /**
   * Claude Code reads its permission mode from the command line, so the process starts again in the new mode and
   * resumes the same conversation. Between turns only: the reactor sends a change with a new message.
   */
  private async restartInMode(
    threadId: ThreadId,
    permissionMode: NonNullable<ClientStart["permissionMode"]>,
  ): Promise<{ session: ProviderSession; client: ClaudeClient; unsubscribe: () => void; start: ClientStart }> {
    const context = this.context(threadId);
    const resumeSessionId = context.session.providerSessionId ?? context.client.sessionId;
    if (!resumeSessionId) {
      throw new ClaudeProviderError(
        "unsupported",
        "Claude Code cannot change permissions in this chat yet. Start a new chat to use another mode.",
      );
    }
    const start: ClientStart = { ...context.start, permissionMode, resumeSessionId };
    context.unsubscribe();
    await context.client.close();
    let client: ClaudeClient;
    try {
      client = await this.options.createClient(start);
    } catch (error) {
      this.sessions.delete(threadId);
      const reason = error instanceof Error ? error.message : "Claude Code did not start again.";
      this.emit({ type: "session.closed", threadId, reason });
      throw error;
    }
    const unsubscribe = client.subscribe((event) => this.onClaudeEvent(threadId, start.cwd, event));
    const next = { session: context.session, client, unsubscribe, start };
    this.sessions.set(threadId, next);
    return next;
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
