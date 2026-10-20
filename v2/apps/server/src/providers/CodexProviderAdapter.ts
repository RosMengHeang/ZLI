import type { ProviderCapabilities, ThreadId } from "@zli-v2/contracts";
import type { CodexAppServerClient, CodexProviderEvent } from "@zli-v2/provider-codex";

import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderSession,
  ProviderSessionStart,
  ProviderTurnInput,
} from "./ProviderService.js";
import { toolActivity } from "./toolActivity.js";

type CodexClient = Pick<
  CodexAppServerClient,
  | "startSession"
  | "sendTurn"
  | "interruptTurn"
  | "respondToRequest"
  | "readThread"
  | "rollbackThread"
  | "subscribe"
  | "close"
>;

export class CodexProviderAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  readonly capabilities: ProviderCapabilities = {
    exactResume: true,
    structuredApproval: true,
    structuredUserInput: true,
    conversationRollback: true,
    modelSwitch: "unsupported",
  };
  private client: CodexClient | undefined;
  private unsubscribeClient: (() => void) | undefined;
  private readonly sessions = new Map<string, { providerThreadId: string; session: ProviderSession }>();
  private readonly listeners = new Set<(event: ProviderEvent) => void>();

  constructor(private readonly options: { createClient: () => Promise<CodexClient> }) {}

  async startSession(input: ProviderSessionStart): Promise<ProviderSession> {
    const client = await this.ensureClient();
    // Full access keeps Codex's own configured policy, as before supervised mode existed.
    const started = await client.startSession({
      cwd: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      ...(input.permissionMode === "supervised"
        ? { approvalPolicy: "on-request", sandboxPolicy: "workspace-write" }
        : {}),
    });
    const session: ProviderSession = {
      threadId: input.threadId,
      provider: this.provider,
      cwd: input.cwd,
      status: "idle",
    };
    this.sessions.set(input.threadId, { providerThreadId: started.providerThreadId, session });
    return session;
  }

  async sendTurn(input: ProviderTurnInput): Promise<{ turnId: string }> {
    const context = this.context(input.threadId);
    const client = await this.ensureClient();
    const imagePaths = (input.attachments ?? []).map((attachment) => attachment.path);
    const result = await client.sendTurn({
      providerThreadId: context.providerThreadId,
      text: input.text,
      ...(input.model ? { model: input.model } : {}),
      ...(imagePaths.length > 0 ? { imagePaths } : {}),
    });
    return { turnId: result.providerTurnId };
  }

  async interruptTurn(input: { threadId: ThreadId; turnId?: string }): Promise<void> {
    const context = this.context(input.threadId);
    if (!input.turnId) return;
    await (await this.ensureClient()).interruptTurn(context.providerThreadId, input.turnId);
  }

  async respondToRequest(input: { threadId: ThreadId; requestId: string; decision: unknown }): Promise<void> {
    this.context(input.threadId);
    await (await this.ensureClient()).respondToRequest(input.requestId, codexApprovalDecision(input.decision));
  }

  async respondToUserInput(input: {
    threadId: ThreadId;
    requestId: string;
    answers: Record<string, string>;
  }): Promise<void> {
    this.context(input.threadId);
    await (await this.ensureClient()).respondToRequest(input.requestId, { answers: input.answers });
  }

  async stopSession(input: { threadId: ThreadId }): Promise<void> {
    this.context(input.threadId);
    this.sessions.delete(input.threadId);
  }

  listSessions(): ReadonlyArray<ProviderSession> {
    return [...this.sessions.values()].map((context) => context.session);
  }

  hasSession(input: { threadId: ThreadId }): boolean {
    return this.sessions.has(input.threadId);
  }

  async readThread(input: { threadId: ThreadId }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    const context = this.context(input.threadId);
    const result = await (await this.ensureClient()).readThread(context.providerThreadId);
    return { threadId: input.threadId, turns: result.turns };
  }

  async rollbackThread(input: {
    threadId: ThreadId;
    numTurns: number;
  }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    const context = this.context(input.threadId);
    const result = await (await this.ensureClient()).rollbackThread(context.providerThreadId, input.numTurns);
    return { threadId: input.threadId, turns: result.turns };
  }

  async stopAll(): Promise<void> {
    this.sessions.clear();
    this.unsubscribeClient?.();
    this.unsubscribeClient = undefined;
    await this.client?.close();
    this.client = undefined;
  }

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async ensureClient(): Promise<CodexClient> {
    if (this.client) return this.client;
    this.client = await this.options.createClient();
    this.unsubscribeClient = this.client.subscribe((event) => this.onCodexEvent(event));
    return this.client;
  }

  private context(threadId: ThreadId): { providerThreadId: string; session: ProviderSession } {
    const context = this.sessions.get(threadId);
    if (!context) throw new Error(`Codex session does not exist: ${threadId}`);
    return context;
  }

  private onCodexEvent(event: CodexProviderEvent): void {
    if (event.type === "session.closed") {
      const closed = [...this.sessions.values()];
      // The app server is gone; the next session must spawn a fresh process instead of reusing a dead client.
      this.sessions.clear();
      this.unsubscribeClient?.();
      this.unsubscribeClient = undefined;
      this.client = undefined;
      for (const context of closed) {
        this.emit({ type: "session.closed", threadId: context.session.threadId, reason: event.reason });
      }
      return;
    }
    if (event.type === "protocol.error") {
      this.emit({ type: "provider.error", message: event.message });
      return;
    }
    const providerThreadId = "providerThreadId" in event ? event.providerThreadId : undefined;
    const context = providerThreadId
      ? [...this.sessions.values()].find((candidate) => candidate.providerThreadId === providerThreadId)
      : undefined;
    if (!context) return;
    switch (event.type) {
      case "assistant.delta":
        this.emit({
          type: "assistant.delta",
          threadId: context.session.threadId,
          turnId: event.providerTurnId,
          text: event.text,
        });
        return;
      case "turn.started":
        this.emit({ type: "turn.started", threadId: context.session.threadId, turnId: event.providerTurnId });
        return;
      case "tool.updated":
        this.emit({
          type: "activity",
          threadId: context.session.threadId,
          turnId: event.providerTurnId,
          activity: toolActivity(event.tool, context.session.cwd),
        });
        return;
      case "turn.completed":
        this.emit({
          type: "turn.completed",
          threadId: context.session.threadId,
          turnId: event.providerTurnId,
          status: event.status,
        });
        return;
      case "approval.requested":
        this.emit({
          type: "approval.requested",
          threadId: context.session.threadId,
          requestId: event.requestId,
          payload: event.payload,
        });
        return;
      case "user-input.requested":
        this.emit({
          type: "user-input.requested",
          threadId: context.session.threadId,
          requestId: event.requestId,
          payload: event.payload,
        });
        return;
      default:
        return;
    }
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** The UI answers approvals with { approved }; Codex app-server expects { decision }. */
export function codexApprovalDecision(decision: unknown): unknown {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return decision;
  const record = decision as Record<string, unknown>;
  if (typeof record.decision === "string") return { decision: record.decision };
  if (typeof record.approved === "boolean") return { decision: record.approved ? "accept" : "decline" };
  return decision;
}
