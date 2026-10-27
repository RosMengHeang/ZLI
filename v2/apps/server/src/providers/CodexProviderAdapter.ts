import { isImageMimeType, type ProviderCapabilities, type ThreadId } from "@zli-v2/contracts";
import type { CodexAppServerClient, CodexProviderEvent } from "@zli-v2/provider-codex";

import type {
  ProviderAccount,
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
  | "resumeSession"
  | "sendTurn"
  | "interruptTurn"
  | "respondToRequest"
  | "readThread"
  | "rollbackThread"
  | "subscribe"
  | "close"
>;

type Connection = { client: CodexClient; unsubscribe: () => void };
type Context = { providerThreadId: string; session: ProviderSession; clientKey: string; account?: ProviderAccount };

/** Threads on the usual login share this app server; each account gets its own, with its own CODEX_HOME. */
const USUAL_CLIENT = "";

export class CodexProviderAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  readonly capabilities: ProviderCapabilities = {
    exactResume: true,
    structuredApproval: true,
    structuredUserInput: true,
    conversationRollback: true,
    modelSwitch: "unsupported",
  };
  private readonly connections = new Map<string, Promise<Connection>>();
  private readonly sessions = new Map<string, Context>();
  private readonly listeners = new Set<(event: ProviderEvent) => void>();

  constructor(
    private readonly options: {
      createClient: (input: { account?: ProviderAccount }) => Promise<CodexClient>;
      /** Config overrides for one thread; the app server is shared, so per-thread values go here. */
      threadConfig?: (
        input: ProviderSessionStart,
      ) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
    },
  ) {}

  async startSession(input: ProviderSessionStart): Promise<ProviderSession> {
    const clientKey = input.account?.accountId ?? USUAL_CLIENT;
    const client = await this.ensureClient(clientKey, input.account);
    const config = await this.options.threadConfig?.(input);
    // Full access keeps Codex's own configured policy, as before supervised mode existed.
    // The other two match Codex's own Read only and Auto presets.
    const settings = {
      cwd: input.cwd,
      ...(config ? { config } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.permissionMode === "supervised"
        ? { approvalPolicy: "on-request", sandboxPolicy: "workspace-write" }
        : input.permissionMode === "read-only"
          ? { approvalPolicy: "on-request", sandboxPolicy: "read-only" }
          : {}),
    };
    // A failed resume throws so the caller decides whether to start over; a fresh thread here would lose that choice.
    const started = input.resumeSessionId
      ? await client.resumeSession({ providerThreadId: input.resumeSessionId, ...settings })
      : await client.startSession(settings);
    const session: ProviderSession = {
      threadId: input.threadId,
      provider: this.provider,
      cwd: input.cwd,
      status: "idle",
      providerSessionId: started.providerThreadId,
    };
    this.sessions.set(input.threadId, {
      providerThreadId: started.providerThreadId,
      session,
      clientKey,
      ...(input.account ? { account: input.account } : {}),
    });
    return session;
  }

  async sendTurn(input: ProviderTurnInput): Promise<{ turnId: string }> {
    const context = this.context(input.threadId);
    const client = await this.clientFor(context);
    const imagePaths = (input.attachments ?? [])
      .filter((attachment) => isImageMimeType(attachment.mimeType))
      .map((attachment) => attachment.path);
    const result = await client.sendTurn({
      providerThreadId: context.providerThreadId,
      text: input.text,
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
      ...(imagePaths.length > 0 ? { imagePaths } : {}),
    });
    return { turnId: result.providerTurnId };
  }

  async interruptTurn(input: { threadId: ThreadId; turnId?: string }): Promise<void> {
    const context = this.context(input.threadId);
    if (!input.turnId) return;
    await (await this.clientFor(context)).interruptTurn(context.providerThreadId, input.turnId);
  }

  async respondToRequest(input: { threadId: ThreadId; requestId: string; decision: unknown }): Promise<void> {
    const context = this.context(input.threadId);
    await (await this.clientFor(context)).respondToRequest(input.requestId, codexApprovalDecision(input.decision));
  }

  async respondToUserInput(input: {
    threadId: ThreadId;
    requestId: string;
    answers: Record<string, string>;
  }): Promise<void> {
    const context = this.context(input.threadId);
    await (await this.clientFor(context)).respondToRequest(input.requestId, codexUserInputAnswers(input.answers));
  }

  async stopSession(input: { threadId: ThreadId }): Promise<void> {
    const context = this.context(input.threadId);
    this.sessions.delete(input.threadId);
    const inUse = [...this.sessions.values()].some((candidate) => candidate.clientKey === context.clientKey);
    // An account's app server only exists for its threads; the shared one stays up as before.
    if (!inUse && context.clientKey !== USUAL_CLIENT) await this.closeClient(context.clientKey);
  }

  listSessions(): ReadonlyArray<ProviderSession> {
    return [...this.sessions.values()].map((context) => context.session);
  }

  hasSession(input: { threadId: ThreadId }): boolean {
    return this.sessions.has(input.threadId);
  }

  async readThread(input: { threadId: ThreadId }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    const context = this.context(input.threadId);
    const result = await (await this.clientFor(context)).readThread(context.providerThreadId);
    return { threadId: input.threadId, turns: result.turns };
  }

  async rollbackThread(input: {
    threadId: ThreadId;
    numTurns: number;
  }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    const context = this.context(input.threadId);
    const result = await (await this.clientFor(context)).rollbackThread(context.providerThreadId, input.numTurns);
    return { threadId: input.threadId, turns: result.turns };
  }

  async stopAll(): Promise<void> {
    this.sessions.clear();
    await Promise.all([...this.connections.keys()].map((key) => this.closeClient(key)));
  }

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async ensureClient(key: string, account: ProviderAccount | undefined): Promise<CodexClient> {
    let connection = this.connections.get(key);
    if (!connection) {
      connection = this.options.createClient(account ? { account } : {}).then((client) => ({
        client,
        unsubscribe: client.subscribe((event) => this.onCodexEvent(key, event)),
      }));
      this.connections.set(key, connection);
      // A failed start must not stick, or every later thread on this account would fail the same way.
      connection.catch(() => {
        if (this.connections.get(key) === connection) this.connections.delete(key);
      });
    }
    return (await connection).client;
  }

  private clientFor(context: Context): Promise<CodexClient> {
    return this.ensureClient(context.clientKey, context.account);
  }

  private async closeClient(key: string): Promise<void> {
    const connection = this.connections.get(key);
    this.connections.delete(key);
    if (!connection) return;
    const opened = await connection.catch(() => undefined);
    if (!opened) return;
    opened.unsubscribe();
    await opened.client.close();
  }

  private context(threadId: ThreadId): Context {
    const context = this.sessions.get(threadId);
    if (!context) throw new Error(`Codex session does not exist: ${threadId}`);
    return context;
  }

  private onCodexEvent(key: string, event: CodexProviderEvent): void {
    if (event.type === "session.closed") {
      const closed = [...this.sessions.values()].filter((context) => context.clientKey === key);
      // The app server is gone; the next session must spawn a fresh process instead of reusing a dead client.
      for (const context of closed) this.sessions.delete(context.session.threadId);
      const connection = this.connections.get(key);
      this.connections.delete(key);
      void connection?.then((opened) => opened.unsubscribe()).catch(() => undefined);
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
      ? [...this.sessions.values()].find(
          (candidate) => candidate.clientKey === key && candidate.providerThreadId === providerThreadId,
        )
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
      case "usage.updated":
        this.emit({
          type: "usage",
          threadId: context.session.threadId,
          turnId: event.providerTurnId,
          usage: event.usage,
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

/** Codex app-server keys each answer by question id and takes a list of strings per question. */
export function codexUserInputAnswers(answers: Record<string, string>): {
  answers: Record<string, { answers: string[] }>;
} {
  return {
    answers: Object.fromEntries(
      Object.entries(answers).map(([questionId, answer]) => [questionId, { answers: [answer] }]),
    ),
  };
}

/** The UI answers approvals with { approved }; Codex app-server expects { decision }. */
export function codexApprovalDecision(decision: unknown): unknown {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return decision;
  const record = decision as Record<string, unknown>;
  if (typeof record.decision === "string") return { decision: record.decision };
  if (record.approved === true && record.scope === "session") return { decision: "acceptForSession" };
  if (typeof record.approved === "boolean") return { decision: record.approved ? "accept" : "decline" };
  return decision;
}
