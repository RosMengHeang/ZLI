import type {
  ListedProviderKind,
  PermissionMode,
  ProviderCapabilities,
  ProviderDiscovery,
  ProviderKind,
  ThreadAttachment,
  ThreadId,
  TurnUsage,
} from "@zli-v2/contracts";

import { RunProblems } from "../accounts/runProblems.js";
import { type CliProbe, createDefaultCliProbe, discoverCliProviders } from "./discoverCliProviders.js";
import type { ProviderActivity } from "./toolActivity.js";

export type { ProviderKind };

export type ProviderSession = {
  threadId: ThreadId;
  provider: ProviderKind;
  cwd: string;
  status: "idle" | "working" | "waiting" | "stopped" | "failed";
  /** Levels the agent reported for this session, for agents that report them when a session starts. */
  reasoningEfforts?: readonly string[];
  /** The agent CLI's own id for the conversation, when it is known as the session starts. */
  providerSessionId?: string;
};

export type ProviderEvent =
  | { type: "assistant.delta"; threadId: ThreadId; turnId: string; text: string }
  | { type: "turn.started"; threadId: ThreadId; turnId: string }
  /** `errorMessage` is what the agent said went wrong, for agents that end a failed turn this way. */
  | { type: "turn.completed"; threadId: ThreadId; turnId: string; status: string; errorMessage?: string }
  | { type: "approval.requested"; threadId: ThreadId; requestId: string; payload: Record<string, unknown> }
  | { type: "user-input.requested"; threadId: ThreadId; requestId: string; payload: Record<string, unknown> }
  | { type: "activity"; threadId: ThreadId; turnId?: string; activity: ProviderActivity }
  /**
   * Part of the agent's thinking for one reasoning block. The first one, which may be empty, starts the
   * block; reasoningId is unique within the session.
   */
  | { type: "reasoning.delta"; threadId: ThreadId; turnId: string; reasoningId: string; text: string }
  /** The block is done. text is its whole content, for an agent that did not stream it. */
  | { type: "reasoning.completed"; threadId: ThreadId; turnId: string; reasoningId: string; text?: string }
  /** Usage so far for one turn. A later report for the same turn replaces it. */
  | { type: "usage"; threadId: ThreadId; turnId: string; usage: TurnUsage }
  | { type: "session.closed"; threadId: ThreadId; reason: string }
  /** The agent CLI named its conversation after the session started, for CLIs that only report it on the first turn. */
  | { type: "session.identified"; threadId: ThreadId; providerSessionId: string }
  /** usageLimit is set when the plan's usage limit stopped the turn. */
  | { type: "provider.error"; threadId?: ThreadId; message: string; usageLimit?: { resetsAt?: string } };

export type ProviderSessionStart = {
  threadId: ThreadId;
  cwd: string;
  /** Omitted means full access, matching how every agent launched before supervised mode existed. */
  permissionMode?: PermissionMode;
  model?: string;
  /** Lets agent tools such as zli-browser act on this thread's worktree. */
  worktreeId?: string;
  /** The account the agent runs under and the environment that selects it. Absent means the usual login. */
  account?: ProviderAccount;
  /** The agent CLI's id from an earlier process. Adapters that can resume continue that conversation. */
  resumeSessionId?: string;
  /** Set when the person let agents work in this project, so the CLI's own folder trust question is answered. */
  trustedProjectPath?: string;
  /** The name the person gave the agent. Claude uses it as the session name instead of asking the model for one. */
  title?: string;
};

export type ProviderAccount = { accountId: string; env: Readonly<Record<string, string>> };

export type ProviderTurnInput = {
  threadId: ThreadId;
  text: string;
  model?: string;
  /** Omitted runs the turn at the agent's default level. */
  reasoningEffort?: string;
  /** The model's `fast` value: run this turn in its faster mode. Omitted runs at standard speed. */
  fast?: string;
  /** Set only when the person changed it; adapters keep it for later turns. */
  permissionMode?: PermissionMode;
  /** Stored images. Their paths are already listed in `text`; adapters may also pass them natively. */
  attachments?: readonly ThreadAttachment[];
};

export interface ProviderAdapter {
  readonly provider: ProviderKind;
  readonly capabilities: ProviderCapabilities;
  startSession(input: ProviderSessionStart): Promise<ProviderSession>;
  sendTurn(input: ProviderTurnInput): Promise<{ turnId: string }>;
  interruptTurn(input: { threadId: ThreadId; turnId?: string }): Promise<void>;
  respondToRequest(input: { threadId: ThreadId; requestId: string; decision: unknown }): Promise<void>;
  respondToUserInput(input: { threadId: ThreadId; requestId: string; answers: Record<string, string> }): Promise<void>;
  stopSession(input: { threadId: ThreadId }): Promise<void>;
  listSessions(): ReadonlyArray<ProviderSession>;
  hasSession(input: { threadId: ThreadId }): boolean;
  readThread(input: { threadId: ThreadId }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }>;
  rollbackThread(input: {
    threadId: ThreadId;
    numTurns: number;
  }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }>;
  stopAll(): Promise<void>;
  subscribe(listener: (event: ProviderEvent) => void): () => void;
}

export class ProviderServiceError extends Error {
  constructor(
    readonly code:
      | "provider_missing"
      | "session_missing"
      | "session_exists"
      | "unsupported"
      | "request_failed"
      | "cli_missing",
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

const DISCOVERY_TTL_MS = 20_000;

export class ProviderService {
  private readonly sessions = new Map<string, ProviderAdapter>();
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly unsubscribers: Array<() => void> = [];
  private discoveryCache: { at: number; value: readonly ProviderDiscovery[] } | undefined;
  /** Discovery spawns every installed CLI, so concurrent callers share one run. */
  private discoveryInFlight: Promise<readonly ProviderDiscovery[]> | undefined;
  /** Threads running on the agent's usual login. Only their failures say something about that login. */
  private readonly usualLogin = new Set<string>();
  /** Account failures from runs, shown with each agent until a run succeeds or the login changes. */
  readonly runProblems = new RunProblems();

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly cliProbe: CliProbe = createDefaultCliProbe(),
  ) {
    for (const adapter of registry.list()) {
      this.unsubscribers.push(adapter.subscribe((event) => this.onAdapterEvent(adapter, event)));
    }
  }

  /** `refresh` skips the cache, for example right after the person installed an agent. */
  async discoverProviders(refresh = false): Promise<readonly ProviderDiscovery[]> {
    if (refresh && !this.discoveryInFlight) this.discoveryCache = undefined;
    const cached = this.discoveryCache;
    if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return this.runProblems.apply(cached.value);
    this.discoveryInFlight ??= discoverCliProviders(this.cliProbe)
      .then((value) => {
        this.discoveryCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.discoveryInFlight = undefined;
      });
    return this.runProblems.apply(await this.discoveryInFlight);
  }

  /** Called when an agent's recorded run problem appears or goes away, so clients can be told. */
  onProvidersChanged(listener: () => void): () => void {
    return this.runProblems.subscribe(listener);
  }

  private recordProblem(provider: ProviderKind, threadId: string | undefined, message: string | undefined): void {
    if (threadId === undefined || !this.usualLogin.has(threadId)) return;
    const login = this.discoveryCache?.value.find((entry) => entry.provider === provider);
    this.runProblems.record(
      provider as ListedProviderKind,
      message,
      login?.status === "found" ? login.login : undefined,
    );
  }

  async startSession(input: ProviderSessionStart & { provider: ProviderKind }): Promise<ProviderSession> {
    const current = this.sessions.get(input.threadId);
    if (current?.hasSession({ threadId: input.threadId }))
      throw new ProviderServiceError("session_exists", `Session already exists: ${input.threadId}`);
    this.sessions.delete(input.threadId);
    const adapter = this.registry.get(input.provider);
    if (!adapter) throw new ProviderServiceError("provider_missing", `Provider is not available: ${input.provider}`);
    if (input.account) this.usualLogin.delete(input.threadId);
    else this.usualLogin.add(input.threadId);
    try {
      const session = await adapter.startSession(input);
      this.sessions.set(input.threadId, adapter);
      return session;
    } catch (error) {
      this.recordProblem(input.provider, input.threadId, error instanceof Error ? error.message : undefined);
      const missing = missingCliError(error);
      if (missing) throw new ProviderServiceError("cli_missing", missing.message, { cause: error });
      const detail = error instanceof Error && error.message.trim() ? ` ${error.message.trim()}` : "";
      throw new ProviderServiceError("request_failed", `Provider session failed to start.${detail}`, { cause: error });
    }
  }

  async sendTurn(input: ProviderTurnInput): Promise<{ turnId: string }> {
    const adapter = this.adapterFor(input.threadId);
    try {
      return await adapter.sendTurn(input);
    } catch (error) {
      this.recordProblem(adapter.provider, input.threadId, error instanceof Error ? error.message : undefined);
      throw error;
    }
  }

  async interruptTurn(input: { threadId: ThreadId; turnId?: string }): Promise<void> {
    await this.adapterFor(input.threadId).interruptTurn(input);
  }

  async respondToRequest(input: { threadId: ThreadId; requestId: string; decision: unknown }): Promise<void> {
    await this.adapterFor(input.threadId).respondToRequest(input);
  }

  async respondToUserInput(input: {
    threadId: ThreadId;
    requestId: string;
    answers: Record<string, string>;
  }): Promise<void> {
    await this.adapterFor(input.threadId).respondToUserInput(input);
  }

  async stopSession(input: { threadId: ThreadId }): Promise<void> {
    const adapter = this.adapterFor(input.threadId);
    try {
      await adapter.stopSession(input);
    } finally {
      this.sessions.delete(input.threadId);
    }
  }

  listSessions(): ReadonlyArray<ProviderSession> {
    return this.registry.list().flatMap((adapter) => adapter.listSessions());
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId) || this.registry.list().some((adapter) => adapter.hasSession({ threadId }));
  }

  getCapabilities(provider: ProviderKind): ProviderCapabilities {
    const adapter = this.registry.get(provider);
    if (!adapter) throw new ProviderServiceError("provider_missing", `Provider is not available: ${provider}`);
    return adapter.capabilities;
  }

  async readThread(input: { threadId: ThreadId }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    return this.adapterFor(input.threadId).readThread(input);
  }

  async rollbackThread(input: {
    threadId: ThreadId;
    numTurns: number;
  }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    const adapter = this.adapterFor(input.threadId);
    if (!adapter.capabilities.conversationRollback) {
      throw new ProviderServiceError(
        "unsupported",
        `Provider ${adapter.provider} does not support conversation rollback.`,
      );
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
    const adapter =
      this.sessions.get(threadId) ?? this.registry.list().find((candidate) => candidate.hasSession({ threadId }));
    if (!adapter) throw new ProviderServiceError("session_missing", `Provider session does not exist: ${threadId}`);
    return adapter;
  }

  private onAdapterEvent(adapter: ProviderAdapter, event: ProviderEvent): void {
    // Adapters forget a session whose process ended before they report it. A close that arrives after a
    // new session already started for the thread belongs to the old process and leaves the new one alone.
    if (
      event.type === "session.closed" &&
      this.sessions.get(event.threadId) === adapter &&
      !adapter.hasSession({ threadId: event.threadId })
    ) {
      this.sessions.delete(event.threadId);
    }
    if (event.type === "provider.error") this.recordProblem(adapter.provider, event.threadId, event.message);
    else if (event.type === "session.closed") this.recordProblem(adapter.provider, event.threadId, event.reason);
    else if (event.type === "turn.completed" && event.errorMessage)
      this.recordProblem(adapter.provider, event.threadId, event.errorMessage);
    else if (event.type === "turn.completed" && event.status === "completed" && this.usualLogin.has(event.threadId)) {
      // A turn that went through shows the login works, whatever an earlier run said.
      this.runProblems.clear(adapter.provider as ListedProviderKind);
    }
    this.emit(event);
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function missingCliError(error: unknown): Error | undefined {
  if (!(error instanceof Error)) return undefined;
  if (!("code" in error) || error.code !== "cli_missing") return undefined;
  return error;
}
