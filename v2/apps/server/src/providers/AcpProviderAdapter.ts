import type { ProviderCapabilities, ProviderKind, ThreadId } from "@zli-v2/contracts";
import { AcpClient, type AcpProviderEvent, AcpProviderError, type AcpToolUpdate } from "@zli-v2/provider-acp";

import { acpMcpServer, agentEnv, type BrowserToolConfig, mcpServerSpec } from "../browser-tool/browserTool.js";
import { approvalAllowed } from "./ClaudeCodeProviderAdapter.js";
import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderSession,
  ProviderSessionStart,
  ProviderTurnInput,
} from "./ProviderService.js";
import { type ProviderActivity, toolActivity } from "./toolActivity.js";

export type AcpProviderKind = Exclude<ProviderKind, "codex" | "claude-code" | "cursor-agent" | "droid">;

export type AcpProviderConfig = {
  provider: AcpProviderKind;
  displayName: string;
  resolveCommand: () => Promise<string>;
  /** Arguments that start the CLI's ACP server on stdio. */
  acpArgs: readonly string[];
  /** Shown when the agent reports that it needs a login. */
  authHint: string;
  /** Offered to every session as an MCP server, with its shell shim on PATH. */
  browserTool?: BrowserToolConfig;
};

type AcpSessionClient = Pick<
  AcpClient,
  "sendTurn" | "interruptTurn" | "respondToPermission" | "transcript" | "subscribe" | "close"
>;
type ClientStart = Pick<ProviderSessionStart, "cwd" | "permissionMode" | "model" | "worktreeId">;

const MAX_TITLE = 500;
const GENERIC_TITLES = new Set(["Read file", "Edit files", "Search", "List files", "Tool call"]);

/** One adapter per ACP agent CLI. Each session is one long-lived `<cli> <acpArgs>` process. */
export class AcpProviderAdapter implements ProviderAdapter {
  readonly provider: AcpProviderKind;
  readonly capabilities: ProviderCapabilities = {
    exactResume: false,
    structuredApproval: true,
    structuredUserInput: false,
    conversationRollback: false,
    modelSwitch: "in-session",
  };

  private readonly sessions = new Map<
    string,
    { session: ProviderSession; client: AcpSessionClient; unsubscribe: () => void }
  >();
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly createClient: (input: ClientStart) => Promise<AcpSessionClient>;

  constructor(
    private readonly config: AcpProviderConfig,
    options: { createClient?: (input: ClientStart) => Promise<AcpSessionClient> } = {},
  ) {
    this.provider = config.provider;
    this.createClient =
      options.createClient ??
      (async ({ worktreeId, ...input }) => {
        const browserTool = config.browserTool;
        return AcpClient.start({
          ...input,
          command: await config.resolveCommand(),
          args: config.acpArgs,
          displayName: config.displayName,
          authHint: config.authHint,
          ...(browserTool
            ? {
                env: agentEnv(browserTool, worktreeId),
                mcpServers: [acpMcpServer(mcpServerSpec(browserTool, worktreeId))],
              }
            : {}),
        });
      });
  }

  async startSession(input: ProviderSessionStart): Promise<ProviderSession> {
    const client = await this.createClient({
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
    const unsubscribe = client.subscribe((event) => this.onAcpEvent(input.threadId, input.cwd, event));
    this.sessions.set(input.threadId, { session, client, unsubscribe });
    return session;
  }

  async sendTurn(input: ProviderTurnInput): Promise<{ turnId: string }> {
    const context = this.context(input.threadId);
    const attachments = input.attachments?.map((attachment) => ({
      mimeType: attachment.mimeType,
      path: attachment.path,
    }));
    const result = await context.client.sendTurn({
      text: input.text,
      ...(input.model ? { model: input.model } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
    return { turnId: result.providerTurnId };
  }

  async interruptTurn(input: { threadId: ThreadId; turnId?: string }): Promise<void> {
    const context = this.context(input.threadId);
    await context.client.interruptTurn(input.turnId);
  }

  async respondToRequest(input: { threadId: ThreadId; requestId: string; decision: unknown }): Promise<void> {
    const context = this.context(input.threadId);
    const optionId = chosenOption(input.decision);
    await context.client.respondToPermission(input.requestId, {
      allow: approvalAllowed(input.decision),
      ...(optionId ? { optionId } : {}),
    });
  }

  async respondToUserInput(input: {
    threadId: ThreadId;
    requestId: string;
    answers: Record<string, string>;
  }): Promise<void> {
    this.context(input.threadId);
    throw new AcpProviderError(
      "unsupported",
      `${this.config.displayName} adapter does not handle structured user input.`,
    );
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
    throw new AcpProviderError(
      "unsupported",
      `${this.config.displayName} adapter does not support conversation rollback.`,
    );
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
    client: AcpSessionClient;
    unsubscribe: () => void;
  } {
    const context = this.sessions.get(threadId);
    if (!context) throw new Error(`${this.config.displayName} session does not exist: ${threadId}`);
    return context;
  }

  private onAcpEvent(threadId: ThreadId, cwd: string, event: AcpProviderEvent): void {
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
      case "tool.updated":
        this.emit({ type: "activity", threadId, turnId: event.providerTurnId, activity: acpActivity(event.tool, cwd) });
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

/** ACP tools carry a human title; it replaces the classifier's fallback when the input says too little. */
export function acpActivity(tool: AcpToolUpdate, cwd: string): ProviderActivity {
  const activity = toolActivity(tool, cwd);
  const title = tool.title?.replace(/\s+/gu, " ").trim();
  if (!title || !(GENERIC_TITLES.has(activity.title) || activity.title === tool.name)) return activity;
  return { ...activity, title: title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title };
}

/** A client may name the exact ACP option, such as allow_always, instead of a plain approve or reject. */
function chosenOption(decision: unknown): string | undefined {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return undefined;
  const optionId = (decision as Record<string, unknown>).optionId;
  return typeof optionId === "string" && optionId.length > 0 ? optionId : undefined;
}
