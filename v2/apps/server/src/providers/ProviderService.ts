import type { ProviderCapabilities } from "@zli-v2/contracts";
import { ThreadId } from "@zli-v2/contracts";

export type ProviderKind = "codex" | "claude-code" | "cursor-agent" | "opencode";

export type ProviderSession = {
  threadId: ThreadId;
  provider: ProviderKind;
  cwd: string;
  status: "idle" | "working" | "waiting" | "stopped" | "failed";
};

export type ProviderEvent =
  | { type: "assistant.delta"; threadId: ThreadId; turnId: string; text: string }
  | { type: "turn.started"; threadId: ThreadId; turnId: string }
  | { type: "turn.completed"; threadId: ThreadId; turnId: string; status: string }
  | { type: "approval.requested"; threadId: ThreadId; requestId: string; payload: Record<string, unknown> }
  | { type: "user-input.requested"; threadId: ThreadId; requestId: string; payload: Record<string, unknown> }
  | { type: "session.closed"; threadId: ThreadId; reason: string }
  | { type: "provider.error"; threadId?: ThreadId; message: string };

export interface ProviderAdapter {
  readonly provider: ProviderKind;
  readonly capabilities: ProviderCapabilities;
  startSession(input: { threadId: ThreadId; cwd: string }): Promise<ProviderSession>;
  sendTurn(input: { threadId: ThreadId; text: string; model?: string }): Promise<{ turnId: string }>;
  interruptTurn(input: { threadId: ThreadId; turnId?: string }): Promise<void>;
  respondToRequest(input: { threadId: ThreadId; requestId: string; decision: unknown }): Promise<void>;
  respondToUserInput(input: { threadId: ThreadId; requestId: string; answers: Record<string, string> }): Promise<void>;
  stopSession(input: { threadId: ThreadId }): Promise<void>;
  listSessions(): ReadonlyArray<ProviderSession>;
  hasSession(input: { threadId: ThreadId }): boolean;
  readThread(input: { threadId: ThreadId }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }>;
  rollbackThread(input: { threadId: ThreadId; numTurns: number }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }>;
  stopAll(): Promise<void>;
  subscribe(listener: (event: ProviderEvent) => void): () => void;
}

export class ProviderServiceError extends Error {
  constructor(
    readonly code: "provider_missing" | "session_missing" | "session_exists" | "unsupported" | "request_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderServiceError";
  }
}

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderKind, ProviderAdapter>();

  constructor(adapters: readonly ProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  get(provider: ProviderKind): ProviderAdapter | undefined {
    return this.adapters.get(provider);
  }

  list(): ReadonlyArray<ProviderAdapter> {
    return [...this.adapters.values()];
  }
}

export class ProviderService {
  private readonly sessions = new Map<string, ProviderAdapter>();
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(private readonly registry: ProviderRegistry) {
    for (const adapter of registry.list()) {
      this.unsubscribers.push(adapter.subscribe((event) => this.emit(event)));
    }
  }

  async startSession(input: { provider: ProviderKind; threadId: ThreadId; cwd: string }): Promise<ProviderSession> {
    if (this.sessions.has(input.threadId)) throw new ProviderServiceError("session_exists", `Session already exists: ${input.threadId}`);
    const adapter = this.registry.get(input.provider);
    if (!adapter) throw new ProviderServiceError("provider_missing", `Provider is not available: ${input.provider}`);
    try {
      const session = await adapter.startSession(input);
      this.sessions.set(input.threadId, adapter);
      return session;
    } catch (error) {
      throw new ProviderServiceError("request_failed", "Provider session failed to start.", { cause: error });
    }
  }

  async sendTurn(input: { threadId: ThreadId; text: string; model?: string }): Promise<{ turnId: string }> {
    return this.adapterFor(input.threadId).sendTurn(input);
  }

  async interruptTurn(input: { threadId: ThreadId; turnId?: string }): Promise<void> {
    await this.adapterFor(input.threadId).interruptTurn(input);
  }

  async respondToRequest(input: { threadId: ThreadId; requestId: string; decision: unknown }): Promise<void> {
    await this.adapterFor(input.threadId).respondToRequest(input);
  }

  async respondToUserInput(input: { threadId: ThreadId; requestId: string; answers: Record<string, string> }): Promise<void> {
    await this.adapterFor(input.threadId).respondToUserInput(input);
  }

  async stopSession(input: { threadId: ThreadId }): Promise<void> {
    const adapter = this.adapterFor(input.threadId);
    await adapter.stopSession(input);
    this.sessions.delete(input.threadId);
  }

  listSessions(): ReadonlyArray<ProviderSession> {
    return this.registry.list().flatMap((adapter) => adapter.listSessions());
  }

  getCapabilities(provider: ProviderKind): ProviderCapabilities {
    const adapter = this.registry.get(provider);
    if (!adapter) throw new ProviderServiceError("provider_missing", `Provider is not available: ${provider}`);
    return adapter.capabilities;
  }

  async readThread(input: { threadId: ThreadId }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    return this.adapterFor(input.threadId).readThread(input);
  }

  async rollbackThread(input: { threadId: ThreadId; numTurns: number }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    const adapter = this.adapterFor(input.threadId);
    if (!adapter.capabilities.conversationRollback) {
      throw new ProviderServiceError("unsupported", `Provider ${adapter.provider} does not support conversation rollback.`);
    }
    return adapter.rollbackThread(input);
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.registry.list().map((adapter) => adapter.stopAll()));
    this.sessions.clear();
  }

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.listeners.clear();
  }

  private adapterFor(threadId: ThreadId): ProviderAdapter {
    const adapter = this.sessions.get(threadId) ?? this.registry.list().find((candidate) => candidate.hasSession({ threadId }));
    if (!adapter) throw new ProviderServiceError("session_missing", `Provider session does not exist: ${threadId}`);
    return adapter;
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
