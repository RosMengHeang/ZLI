import { createHash, randomUUID } from "node:crypto";

import {
  APP_DRAFT_PREFIX,
  CommandId,
  isAppDraft,
  type ListedProviderKind,
  MAX_REASONING_TEXT,
  ProviderKind,
  type RuntimeEventEnvelope,
  type ThreadAttachment,
  ThreadId,
  type ThreadProjection,
  TurnId,
} from "@zli-v2/contracts";
import { AGENT_MCP_SERVER, BROWSER_MCP_SERVER, MOBILE_MCP_SERVER } from "../browser-tool/browserTool.js";
import type { TurnCheckpoints, TurnStart } from "../checkpoints/TurnCheckpoints.js";
import type { AppsCall, AppsRunResult, AppsVerdict } from "../mcp/AppsProxy.js";
import { appsCallEmail, describeAppsCall, withEmailEdits } from "../mcp/appsPolicy.js";
import { CONNECTED_APPS_SERVER } from "../mcp/ConnectedApps.js";
import type { Engine } from "../orchestration/Engine.js";
import { trustedProject } from "../terminal/agentTrust.js";
import { approvalAllowed } from "./ClaudeCodeProviderAdapter.js";
import type {
  ProviderAccount,
  ProviderEvent,
  ProviderService,
  ProviderSession,
  ProviderSessionStart,
} from "./ProviderService.js";

/** Turns a thread's account into the environment its agent runs with. Undefined means the usual login. */
export type ThreadAccountResolver = (
  provider: ListedProviderKind,
  accountId?: string,
) => Promise<ProviderAccount | undefined>;

type StartIntent = Extract<RuntimeEventEnvelope["event"], { type: "thread.start.requested" }>;
type SendIntent = Extract<RuntimeEventEnvelope["event"], { type: "thread.send.requested" }>;
type SessionInput = ProviderSessionStart & { provider: ProviderKind };
type ActivityEvent = Extract<ProviderEvent, { type: "activity" }>;
type UsageEvent = Extract<ProviderEvent, { type: "usage" }>;
type ThreadStatus = "starting" | "idle" | "working" | "waiting" | "stopped" | "failed";
type StatusDetail = {
  turnId?: string;
  capabilities?: ReturnType<ProviderService["getCapabilities"]>;
  errorMessage?: string;
  usageLimit?: { resetsAt?: string };
};
type PendingDelta = { threadId: string; turnId: string; text: string; timer: ReturnType<typeof setTimeout> };
type ReasoningEvent = Extract<ProviderEvent, { type: "reasoning.delta" | "reasoning.completed" }>;
/** A reasoning block that has not finished. sent counts the characters recorded so far, which MAX_REASONING_TEXT caps. */
type OpenReasoning = {
  threadId: string;
  turnId: string;
  reasoningId: string;
  pending: string;
  sent: number;
  truncated: boolean;
  timer?: ReturnType<typeof setTimeout> | undefined;
};

/** Streaming fragments are coalesced so one reply is one durable event per flush, not one per token. */
const DELTA_FLUSH_MS = 120;
const LIVE_STATUSES = new Set<ThreadStatus>(["starting", "idle", "working", "waiting"]);
const MAX_ACTIVITY_TITLE = 500;
const MAX_ACTIVITY_DETAIL = 4_000;
const MAX_ACTIVITY_ID = 200;
const MAX_ENDED_TURNS = 20;
const MAX_PROVIDER_SESSION_ID = 500;
const FRESH_START_NOTE =
  "The earlier conversation could not be resumed, so the agent started over. It does not remember the messages above.";
/**
 * How long an agent can sit idle before ZLI ends its process. Each idle CLI holds 100 MB or more, so a
 * long list of chats would otherwise keep all of them in memory. The chat stays idle, keeps its name,
 * and the next message starts the process again on the same conversation.
 */
export const DEFAULT_IDLE_STOP_MS = 10 * 60_000;

/**
 * Idle agents that keep their process, so switching between the chats in use answers at once. Past this,
 * the agent idle longest gives back its process; its next message starts it again in about a second.
 */
export const DEFAULT_MAX_WARM_AGENTS = 4;

/** What ZLI sends for the person when it starts an agent again after its turn was cut off. */
export const CONTINUE_PROMPT = "Your last turn was cut off before it finished. Continue where you left off.";
const CRASH_RESUME_NOTE =
  "The agent stopped in the middle of its turn, so ZLI started it again on the same conversation and asked it to continue.";
const RESTART_RESUME_NOTE =
  "ZLI restarted while the agent was working, so it started the agent again on the same conversation and asked it to continue.";
/** A turn cut off by a restart longer ago than this is left for the person, as their plans may have moved on. */
const RESTART_RESUME_WINDOW_MS = 30 * 60_000;

/** An idle thread whose agent process was ended to save memory. `stopped` settles once the process is gone. */
type Parked = { stopped: Promise<void> };
/** Events that mean the agent has work again, so its idle clock starts over. */
const WAKING_EVENTS = new Set([
  "thread.send.requested",
  "thread.queued",
  "thread.request.requested",
  "thread.resume.requested",
  "thread.start.requested",
]);

export class ProviderReactor {
  private readonly tasks = new Set<Promise<void>>();
  private readonly pendingDeltas = new Map<string, PendingDelta>();
  /** Reasoning blocks that started and have not finished, keyed by thread and the provider's block id. */
  private readonly openReasoning = new Map<string, OpenReasoning>();
  /** Threads whose session was deleted. Late provider output for them has no record to land on. */
  private readonly deleted = new Set<string>();
  /** The provider's id for each thread's current turn, as the provider reports it. */
  private readonly activeTurns = new Map<string, string>();
  /**
   * Turns that already ended, per thread. An interrupted turn can still report completion after the
   * next queued message has started, and that late report must not mark the new turn idle.
   */
  private readonly endedTurns = new Map<string, string[]>();
  /** The files before each running turn, keyed by thread and the provider's turn id. */
  private readonly turnStarts = new Map<string, TurnStart>();
  /** Reply characters recorded so far per turn, keyed like pendingDeltas. Tool calls note it as their place. */
  private readonly replyLengths = new Map<string, number>();
  /**
   * Threads started again on an earlier conversation that have not finished a turn yet. Some CLIs only
   * reject a stale conversation id on the first turn, so that turn's message is kept to send again.
   */
  private readonly resuming = new Map<string, { retry?: SendIntent }>();
  /** The send still waiting for the provider's turn id, per thread. */
  private readonly sending = new Map<string, object>();
  /**
   * Sends that were stopped before the provider returned a turn id. Stop has nothing to interrupt yet,
   * so the turn is interrupted as soon as its id arrives instead of being left running.
   */
  private readonly stoppedSends = new Set<object>();
  /** Idle threads with no agent process behind them. The projection still shows them idle. */
  private readonly parked = new Map<string, Parked>();
  /** Threads starting their parked process again, so two sends at once start it once. */
  private readonly waking = new Map<string, Promise<void>>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** When each idle agent that still has its process went idle, oldest first to give back. */
  private readonly idleSince = new Map<string, number>();
  private readonly maxWarmAgents: number;
  /** Threads ZLI already started again after a cut-off turn, until one of their turns finishes. */
  private readonly autoContinued = new Set<string>();
  private readonly autoResume: boolean;
  private readonly idleStopMs: number;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeProvider: () => void;

  constructor(
    private readonly engine: Engine,
    private readonly service: ProviderService,
    private readonly checkpoints?: Pick<TurnCheckpoints, "capture" | "record">,
    private readonly options: {
      resolveAccount?: ThreadAccountResolver;
      /** Runs an app call the person sent from its card, with the saved key. */
      runApps?: (tool: string, params: Record<string, unknown> | undefined) => Promise<AppsRunResult>;
      /** The clock app cards expire by; tests set it. */
      now?: () => number;
      /** How long an idle agent keeps its process. 0 keeps it until the chat stops. */
      idleStopMs?: number;
      /** Most idle agents that keep their process. 0 keeps every one until its idle timeout. */
      maxWarmAgents?: number;
      /** Off leaves a turn cut off by a crash or restart for the person to pick up. On unless set. */
      autoResume?: boolean;
    } = {},
  ) {
    this.idleStopMs = options.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
    this.maxWarmAgents = options.maxWarmAgents ?? DEFAULT_MAX_WARM_AGENTS;
    this.autoResume = options.autoResume ?? true;
    this.unsubscribe = engine.subscribe((envelope) => this.onEvent(envelope));
    // App cards nobody answered within a day go away, so an old one is never sent by a late click.
    this.draftSweep = setInterval(() => void this.expireAppDrafts().catch(() => undefined), APP_DRAFT_SWEEP_MS);
    this.draftSweep.unref?.();
    this.unsubscribeProvider = service.subscribe((event) => this.onProviderEvent(event));
  }

  stop(): void {
    clearInterval(this.draftSweep);
    this.unsubscribe();
    this.unsubscribeProvider();
    for (const pending of this.pendingDeltas.values()) clearTimeout(pending.timer);
    this.pendingDeltas.clear();
    for (const open of this.openReasoning.values()) clearTimeout(open.timer);
    this.openReasoning.clear();
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    this.idleSince.clear();
  }

  async waitForIdle(): Promise<void> {
    this.flushAllDeltas();
    while (this.tasks.size > 0) await Promise.all([...this.tasks]);
    await this.engine.projection();
  }

  /**
   * Provider sessions live in this process only. Threads persisted as live by a
   * previous run have no session behind them, so they are marked stopped
   * instead of appearing idle and failing on the next send.
   */
  async reconcileOrphanedThreads(): Promise<void> {
    await this.expireAppDrafts().catch(() => undefined);
    const projection = await this.engine.projection();
    for (const thread of projection.threads) {
      if (this.service.hasSession(ThreadId.parse(thread.threadId))) continue;
      const waitingOnPerson = hasOpenRequest(projection, thread.threadId);
      if (!LIVE_STATUSES.has(thread.status)) {
        // Older runs could end a chat without closing its requests, which left the chat stuck.
        for (const request of projection.requests ?? []) {
          // An app card is ZLI's own and runs without the agent, so it outlives the session.
          if (request.threadId === thread.threadId && !isAppDraft(request.requestId))
            await this.dropRequest(thread.threadId, request.requestId);
        }
        continue;
      }
      await this.status(thread.threadId, "stopped", {
        errorMessage: thread.providerSessionId
          ? "The agent stopped when ZLI restarted. Send a message to pick up where it left off."
          : "The agent session ended when ZLI restarted. Start a new chat to continue.",
      });
      // A turn that was running when ZLI went away is picked up again, unless it is old news.
      const changed = thread.updatedAt ? Date.parse(thread.updatedAt) : Number.NaN;
      const recent = Number.isFinite(changed) && this.now() - changed <= RESTART_RESUME_WINDOW_MS;
      // A turn that was asking the person something is left for them: they were in the middle of deciding.
      if (thread.status === "working" && recent && !waitingOnPerson)
        await this.autoContinue(thread.threadId, "restart");
    }
  }

  /**
   * Starts an agent whose turn was cut off again on the same conversation and asks it to carry on, so the
   * person does not have to. It happens once until a turn finishes, so an agent that keeps failing stops and
   * waits for the person instead of starting over and over.
   */
  private async autoContinue(threadId: string, reason: "crash" | "restart"): Promise<void> {
    if (!this.autoResume || this.autoContinued.has(threadId) || this.deleted.has(threadId)) return;
    const projection = await this.engine.projection();
    const thread = projection.threads.find((entry) => entry.threadId === threadId);
    if (thread?.status !== "stopped" || !thread.providerSessionId) return;
    if (hasOpenRequest(projection, threadId)) return;
    this.autoContinued.add(threadId);
    await this.message(threadId, "system", reason === "crash" ? CRASH_RESUME_NOTE : RESTART_RESUME_NOTE);
    try {
      await this.engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        // Queued like a message the person sends to a stopped chat: the chat resumes, then it goes out.
        command: {
          type: "thread.queue",
          queueId: randomUUID(),
          threadId: ThreadId.parse(threadId),
          text: CONTINUE_PROMPT,
        },
      });
    } catch {
      // The chat keeps its message saying how to pick up by hand.
    }
  }

  private onEvent(envelope: RuntimeEventEnvelope): void {
    const event = envelope.event as { type: string; threadId?: unknown; status?: unknown };
    if (typeof event.threadId === "string") {
      if (event.type === "thread.status.changed") {
        if (event.status === "idle") this.armIdleStop(event.threadId);
        else this.clearIdleStop(event.threadId);
      } else if (WAKING_EVENTS.has(event.type)) this.clearIdleStop(event.threadId);
    }
    switch (envelope.event.type) {
      case "thread.start.requested":
        this.track(this.start(envelope.event));
        return;
      case "thread.send.requested":
        this.track(this.send(envelope.event));
        return;
      case "thread.interrupt.requested":
        this.track(this.interrupt(envelope.event.threadId, envelope.event.turnId));
        return;
      case "thread.stop.requested":
        this.track(this.stopSession(envelope.event.threadId));
        return;
      case "thread.resume.requested":
        this.track(this.resume(envelope.event.threadId, envelope.event.cwd));
        return;
      case "thread.status.changed":
        if (envelope.event.status === "idle") this.track(this.flushQueue(envelope.event.threadId));
        return;
      case "thread.respond.requested":
        this.track(this.respond(envelope.event.threadId, envelope.event.requestId, envelope.event.decision));
        return;
      case "thread.user-input.requested":
        this.track(this.respondUserInput(envelope.event.threadId, envelope.event.requestId, envelope.event.answers));
        return;
      case "session.deleted":
        for (const threadId of envelope.event.threadIds) this.track(this.forget(threadId));
        return;
      default:
        return;
    }
  }

  private async sessionInput(thread: ThreadProjection, cwd: string): Promise<SessionInput> {
    const provider = ProviderKind.parse(thread.provider);
    const account = await this.options.resolveAccount?.(provider, thread.accountId);
    const trustedProjectPath = await trustedProject(this.engine, thread.worktreeId);
    return {
      provider,
      threadId: ThreadId.parse(thread.threadId),
      cwd,
      worktreeId: thread.worktreeId,
      ...(thread.permissionMode ? { permissionMode: thread.permissionMode } : {}),
      ...(thread.unattended ? { unattended: true } : {}),
      ...(thread.model ? { model: thread.model } : {}),
      ...(account ? { account } : {}),
      ...(trustedProjectPath ? { trustedProjectPath } : {}),
      ...(thread.name ? { title: thread.name } : {}),
    };
  }

  private sessionCapabilities(session: ProviderSession): NonNullable<StatusDetail["capabilities"]> {
    return {
      ...this.service.getCapabilities(session.provider),
      ...(session.reasoningEfforts?.length ? { reasoningEfforts: [...session.reasoningEfforts] } : {}),
    };
  }

  private async start(intent: StartIntent): Promise<void> {
    try {
      const session = await this.service.startSession(await this.sessionInput(intent.thread, intent.cwd));
      if (this.deleted.has(intent.thread.threadId)) {
        await this.forget(intent.thread.threadId);
        return;
      }
      await this.recordProviderSession(intent.thread.threadId, session.providerSessionId);
      await this.status(intent.thread.threadId, "idle", { capabilities: this.sessionCapabilities(session) });
    } catch (error) {
      await this.fail(intent.thread.threadId, error, "Provider session failed to start.");
    }
  }

  /** Starts an ended chat's agent on its earlier conversation, or on a new one when that is gone. */
  private async resume(threadId: string, cwd: string): Promise<void> {
    if (this.deleted.has(threadId)) return;
    await this.unpark(threadId);
    const thread = (await this.engine.projection()).threads.find((entry) => entry.threadId === threadId);
    if (!thread) return;
    let input: SessionInput;
    try {
      await this.closeSession(threadId);
      input = await this.sessionInput(thread, cwd);
    } catch (error) {
      await this.fail(threadId, error, "Provider session failed to start.");
      return;
    }
    if (thread.providerSessionId) {
      try {
        const session = await this.service.startSession({ ...input, resumeSessionId: thread.providerSessionId });
        if (this.deleted.has(threadId)) {
          await this.forget(threadId);
          return;
        }
        this.resuming.set(threadId, {});
        await this.recordProviderSession(threadId, session.providerSessionId);
        await this.status(threadId, "idle", { capabilities: this.sessionCapabilities(session) });
        return;
      } catch {
        // The CLI refused the earlier conversation at startup. A fresh one below keeps the chat usable.
      }
    }
    await this.startFresh(threadId, input);
  }

  private armIdleStop(threadId: string): void {
    if (this.parked.has(threadId) || this.deleted.has(threadId)) return;
    this.clearIdleStop(threadId);
    this.idleSince.set(threadId, Date.now());
    if (this.idleStopMs > 0) {
      const timer = setTimeout(() => {
        this.idleTimers.delete(threadId);
        this.idleSince.delete(threadId);
        this.track(this.park(threadId));
      }, this.idleStopMs);
      timer.unref?.();
      this.idleTimers.set(threadId, timer);
    }
    this.enforceWarmLimit();
  }

  private clearIdleStop(threadId: string): void {
    const timer = this.idleTimers.get(threadId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(threadId);
    this.idleSince.delete(threadId);
  }

  /**
   * Keeps only the agents that went idle most recently running. With many chats open, the ones nobody used
   * for a while give back their process now instead of after the idle timeout.
   */
  private enforceWarmLimit(): void {
    if (this.maxWarmAgents <= 0 || this.idleSince.size <= this.maxWarmAgents) return;
    const oldest = [...this.idleSince].sort((a, b) => a[1] - b[1]).slice(0, this.idleSince.size - this.maxWarmAgents);
    for (const [threadId] of oldest) {
      this.clearIdleStop(threadId);
      this.track(this.park(threadId));
    }
  }

  /**
   * Ends an idle agent's process and keeps the chat as it is. Only a chat that can pick up its conversation
   * again is parked: it is idle, has the CLI's conversation id, and nothing waits on the agent or the person.
   */
  private async park(threadId: string): Promise<void> {
    const id = ThreadId.parse(threadId);
    if (this.deleted.has(threadId) || this.parked.has(threadId) || !this.service.hasSession(id)) return;
    if (this.activeTurns.has(threadId) || this.sending.has(threadId) || this.resuming.has(threadId)) return;
    const projection = await this.engine.projection();
    const thread = projection.threads.find((entry) => entry.threadId === threadId);
    if (thread?.status !== "idle" || !thread.providerSessionId) return;
    if ((projection.requests ?? []).some((request) => request.threadId === threadId)) return;
    if ((projection.queuedMessages ?? []).some((queued) => queued.threadId === threadId)) return;
    // Checked again after the read: a send that arrived meanwhile keeps the process.
    if (this.sending.has(threadId) || this.idleTimers.has(threadId)) return;
    const stopped = this.service.stopSession({ threadId: id }).catch(() => undefined);
    this.parked.set(threadId, { stopped });
    await stopped;
  }

  /** Starts a parked agent again on its conversation before its next turn. */
  private wake(threadId: string): Promise<void> {
    const running = this.waking.get(threadId);
    if (running) return running;
    const parked = this.parked.get(threadId);
    if (!parked) return Promise.resolve();
    const waking = (async () => {
      await parked.stopped;
      const projection = await this.engine.projection();
      const thread = projection.threads.find((entry) => entry.threadId === threadId);
      const cwd = projection.worktrees.find((worktree) => worktree.worktreeId === thread?.worktreeId)?.path;
      if (!thread || !cwd) throw new Error("This chat's worktree is gone. Start a new chat.");
      const input = await this.sessionInput(thread, cwd);
      if (thread.providerSessionId) {
        try {
          const session = await this.service.startSession({ ...input, resumeSessionId: thread.providerSessionId });
          // Some CLIs only refuse an old conversation on its first turn; this keeps that turn's message to retry.
          this.resuming.set(threadId, {});
          await this.recordProviderSession(threadId, session.providerSessionId);
          return;
        } catch {
          // The CLI refused the earlier conversation at startup. A fresh one below keeps the chat usable.
        }
      }
      const session = await this.service.startSession(input);
      await this.recordProviderSession(threadId, session.providerSessionId);
      await this.message(threadId, "system", FRESH_START_NOTE);
    })().finally(() => {
      this.parked.delete(threadId);
      this.waking.delete(threadId);
    });
    this.waking.set(threadId, waking);
    return waking;
  }

  /** Forgets that a thread is parked, once its process has finished closing. */
  private async unpark(threadId: string): Promise<void> {
    const parked = this.parked.get(threadId);
    if (!parked) return;
    await this.waking.get(threadId)?.catch(() => undefined);
    await parked.stopped;
    this.parked.delete(threadId);
  }

  /** The earlier conversation is gone: start a new one in the same chat and say so once. */
  private async startFresh(threadId: string, input: SessionInput, retry?: SendIntent): Promise<void> {
    try {
      await this.closeSession(threadId);
      const session = await this.service.startSession(input);
      if (this.deleted.has(threadId)) {
        await this.forget(threadId);
        return;
      }
      await this.recordProviderSession(threadId, session.providerSessionId);
      await this.message(threadId, "system", FRESH_START_NOTE);
      const capabilities = this.sessionCapabilities(session);
      if (!retry) {
        await this.status(threadId, "idle", { capabilities });
        return;
      }
      // Not idle, so the queue does not send its next message before this one.
      await this.status(threadId, "starting", { capabilities });
      await this.send(retry, { record: false });
    } catch (error) {
      await this.fail(threadId, error, "Provider session failed to start.");
    }
  }

  private async recoverResume(threadId: string, retry?: SendIntent): Promise<void> {
    const projection = await this.engine.projection();
    const thread = projection.threads.find((entry) => entry.threadId === threadId);
    const cwd = projection.worktrees.find((worktree) => worktree.worktreeId === thread?.worktreeId)?.path;
    if (!thread || !cwd || this.deleted.has(threadId)) return;
    try {
      await this.startFresh(threadId, await this.sessionInput(thread, cwd), retry);
    } catch (error) {
      await this.fail(threadId, error, "Provider session failed to start.");
    }
  }

  private async closeSession(threadId: string): Promise<void> {
    const id = ThreadId.parse(threadId);
    if (!this.service.hasSession(id)) return;
    try {
      await this.service.stopSession({ threadId: id });
    } catch {
      // The process is already gone.
    }
  }

  private recordProviderSession(threadId: string, providerSessionId: string | undefined): Promise<void> {
    const id = providerSessionId?.trim();
    if (!id || id.length > MAX_PROVIDER_SESSION_ID || this.deleted.has(threadId)) return Promise.resolve();
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: { type: "thread.provider-session", threadId: ThreadId.parse(threadId), providerSessionId: id },
      })
      .then(() => undefined);
  }

  private async send(intent: SendIntent, options: { record?: boolean } = {}): Promise<void> {
    if (intent.steer) {
      await this.steer(intent);
      return;
    }
    const { threadId, text } = intent;
    const attachments = intent.attachments ?? [];
    if (options.record !== false) await this.message(threadId, "user", text, undefined, attachments);
    if (this.parked.has(threadId)) {
      try {
        await this.wake(threadId);
      } catch (error) {
        await this.fail(threadId, error, "Provider session failed to start.");
        return;
      }
    }
    const resuming = this.resuming.get(threadId);
    if (resuming && !resuming.retry) resuming.retry = intent;
    const sendToken = {};
    this.sending.set(threadId, sendToken);
    try {
      await this.sendTurn(intent, attachments, sendToken);
    } finally {
      if (this.sending.get(threadId) === sendToken) this.sending.delete(threadId);
      this.stoppedSends.delete(sendToken);
    }
  }

  /**
   * Hands a message to the agent's running turn, which reads it at its next step. If that turn has ended or
   * the agent turns the message down, it queues like any other message and goes out as the next turn.
   */
  private async steer(intent: SendIntent): Promise<void> {
    const { threadId, text } = intent;
    const attachments = intent.attachments ?? [];
    const turnId = this.activeTurns.get(threadId);
    if (turnId && !this.parked.has(threadId) && !this.sending.has(threadId) && !this.resuming.has(threadId)) {
      // What the agent wrote before reading the message stays above it in the chat.
      this.flushThreadDeltas(threadId);
      const prompt = promptWithAttachments(text, attachments);
      try {
        await this.service.steerTurn({
          threadId: ThreadId.parse(threadId),
          turnId,
          text: intent.context
            ? `${intent.context}

${prompt}`
            : prompt,
          ...(attachments.length > 0 ? { attachments } : {}),
        });
        this.flushThreadDeltas(threadId);
        await this.message(threadId, "user", text, undefined, attachments);
        return;
      } catch {
        // Queued below.
      }
    }
    try {
      await this.engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: {
          type: "thread.queue",
          queueId: randomUUID(),
          threadId: ThreadId.parse(threadId),
          text,
          ...(intent.model ? { model: intent.model } : {}),
          ...(intent.reasoningEffort ? { reasoningEffort: intent.reasoningEffort } : {}),
          ...(intent.fast ? { fast: intent.fast } : {}),
          ...(intent.permissionMode ? { permissionMode: intent.permissionMode } : {}),
          ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
          ...(intent.context ? { context: intent.context } : {}),
        },
      });
    } catch (error) {
      const reason = error instanceof Error && error.message ? ` ${error.message}` : "";
      await this.message(threadId, "system", `This message did not reach the agent: "${text}".${reason}`);
    }
  }

  private async sendTurn(
    intent: SendIntent,
    attachments: readonly ThreadAttachment[],
    sendToken: object,
  ): Promise<void> {
    const { threadId, text, model, reasoningEffort, fast, permissionMode } = intent;
    // Taken before the provider sees the message, so none of the turn's edits can land first.
    const start = await this.checkpoints?.capture(threadId);
    try {
      const result = await this.service.sendTurn({
        threadId: ThreadId.parse(threadId),
        text: intent.context
          ? `${intent.context}\n\n${promptWithAttachments(text, attachments)}`
          : promptWithAttachments(text, attachments),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(fast ? { fast } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      if (start) this.turnStarts.set(turnKey(threadId, result.turnId), start);
      if (this.turnEnded(threadId, result.turnId)) {
        this.recordCheckpoint(threadId, result.turnId);
      } else if (this.stoppedSends.has(sendToken)) {
        await this.interruptStarted(threadId, result.turnId);
      } else {
        this.activeTurns.set(threadId, result.turnId);
        await this.status(threadId, "working", { turnId: result.turnId });
      }
    } catch (error) {
      const retry = this.takeResume(threadId);
      if (retry) {
        await this.recoverResume(threadId, retry);
        return;
      }
      await this.fail(threadId, error, "Provider turn failed.");
    }
  }

  /** Ends a pending resume and returns the message to send again, if the first turn had started. */
  private takeResume(threadId: string): SendIntent | undefined {
    const resuming = this.resuming.get(threadId);
    this.resuming.delete(threadId);
    return resuming?.retry;
  }

  private async interrupt(threadId: string, projectedTurnId?: string): Promise<void> {
    // A parked agent has no process and no turn, so there is nothing to interrupt.
    if (this.parked.has(threadId) && !this.waking.has(threadId)) return;
    // The projection keeps a sanitized turn id, so the provider's own id is preferred when known.
    const active = this.activeTurns.get(threadId);
    const pendingSend = this.sending.get(threadId);
    if (!active && pendingSend) this.stoppedSends.add(pendingSend);
    const turnId = active ?? projectedTurnId;
    try {
      await this.service.interruptTurn({ threadId: ThreadId.parse(threadId), ...(turnId ? { turnId } : {}) });
      this.flushThreadDeltas(threadId);
      if (active) {
        this.closeTurnReasoning(threadId, active);
        this.endTurn(threadId, active);
        this.recordCheckpoint(threadId, active);
      }
      await this.status(threadId, "idle");
    } catch (error) {
      await this.fail(threadId, error, "Provider interruption failed.");
    }
  }

  /** Interrupts a turn whose Stop arrived while the provider was still accepting the message. */
  private async interruptStarted(threadId: string, turnId: string): Promise<void> {
    try {
      await this.service.interruptTurn({ threadId: ThreadId.parse(threadId), turnId });
      this.flushThreadDeltas(threadId);
      this.closeTurnReasoning(threadId, turnId);
      this.endTurn(threadId, turnId);
      this.recordCheckpoint(threadId, turnId);
      await this.status(threadId, "idle");
    } catch (error) {
      await this.fail(threadId, error, "Provider interruption failed.");
    }
  }

  private async stopSession(threadId: string): Promise<void> {
    this.resuming.delete(threadId);
    this.clearIdleStop(threadId);
    if (this.parked.has(threadId)) {
      await this.unpark(threadId);
      await this.status(threadId, "stopped");
      return;
    }
    try {
      await this.service.stopSession({ threadId: ThreadId.parse(threadId) });
      this.flushThreadDeltas(threadId);
      await this.status(threadId, "stopped");
    } catch (error) {
      await this.fail(threadId, error, "Provider session stop failed.");
    }
  }

  private async forget(threadId: string): Promise<void> {
    this.deleted.add(threadId);
    this.resuming.delete(threadId);
    this.clearIdleStop(threadId);
    await this.unpark(threadId);
    this.activeTurns.delete(threadId);
    this.endedTurns.delete(threadId);
    for (const key of this.turnStarts.keys()) if (key.startsWith(`${threadId}\u0000`)) this.turnStarts.delete(key);
    for (const key of this.replyLengths.keys()) if (key.startsWith(`${threadId}\u0000`)) this.replyLengths.delete(key);
    for (const [key, pending] of this.pendingDeltas) {
      if (pending.threadId !== threadId) continue;
      clearTimeout(pending.timer);
      this.pendingDeltas.delete(key);
    }
    for (const [key, open] of this.openReasoning) {
      if (open.threadId !== threadId) continue;
      clearTimeout(open.timer);
      this.openReasoning.delete(key);
    }
    const id = ThreadId.parse(threadId);
    if (!this.service.hasSession(id)) return;
    try {
      await this.service.stopSession({ threadId: id });
    } catch {
      // The process is already gone.
    }
  }

  private onProviderEvent(event: ProviderEvent): void {
    if (event.threadId && this.deleted.has(event.threadId)) return;
    if (event.type === "assistant.delta") {
      this.bufferDelta(event.threadId, event.turnId, event.text);
      return;
    }
    if (event.type === "reasoning.delta" || event.type === "reasoning.completed") {
      this.reasoning(event);
      return;
    }
    if (event.type === "turn.started") {
      if (this.turnEnded(event.threadId, event.turnId)) return;
      this.activeTurns.set(event.threadId, event.turnId);
      this.track(this.status(event.threadId, "working", { turnId: event.turnId }));
      return;
    }
    if (event.type === "activity") {
      // Text streamed before the tool call has to land first so the work log keeps the provider's order.
      this.flushThreadDeltas(event.threadId);
      this.track(this.activity(event));
      return;
    }
    if (event.type === "usage") {
      this.track(this.usage(event));
      return;
    }
    if (event.type === "session.identified") {
      this.track(this.recordProviderSession(event.threadId, event.providerSessionId));
      return;
    }
    if (event.type === "turn.completed") {
      this.resuming.delete(event.threadId);
      // A finished turn means the agent works again, so a later cut-off turn may be picked up once more.
      this.autoContinued.delete(event.threadId);
      this.flushThreadDeltas(event.threadId);
      // Only this turn's thinking closes, so a late completion after steering leaves the next turn's running,
      // and an interrupted turn's own thinking still ends here.
      this.closeTurnReasoning(event.threadId, event.turnId);
      if (this.turnEnded(event.threadId, event.turnId)) return;
      this.endTurn(event.threadId, event.turnId);
      this.recordCheckpoint(event.threadId, event.turnId);
      this.track(this.status(event.threadId, "idle", { turnId: event.turnId }));
      return;
    }
    if (event.type === "approval.requested") {
      this.flushThreadDeltas(event.threadId);
      this.track(this.approval(event.threadId, event.requestId, event.payload));
      return;
    }
    if (event.type === "user-input.requested") {
      this.flushThreadDeltas(event.threadId);
      this.track(this.request(event.threadId, "user-input", event.requestId, event.payload));
      this.track(this.status(event.threadId, "waiting"));
      return;
    }
    if (event.threadId) {
      // A session that ends mid-turn may still have changed files.
      const active = this.activeTurns.get(event.threadId);
      if (active) this.recordCheckpoint(event.threadId, active);
      if (this.resuming.has(event.threadId)) {
        this.flushThreadDeltas(event.threadId);
        this.closeThreadReasoning(event.threadId);
        if (active) this.endTurn(event.threadId, active);
        this.track(this.recoverResume(event.threadId, this.takeResume(event.threadId)));
        return;
      }
    }
    if (event.type === "session.closed") {
      // ZLI ended this process itself to save memory; the chat is still idle.
      if (this.parked.has(event.threadId) && !this.waking.has(event.threadId)) return;
      this.flushThreadDeltas(event.threadId);
      this.closeThreadReasoning(event.threadId);
      // The turn died with the process. Left active, it would be the one a Stop after the next send interrupts.
      const active = this.activeTurns.get(event.threadId);
      if (active) this.endTurn(event.threadId, active);
      const threadId = event.threadId;
      // Only a process that died in the middle of a turn is started again; an idle one waits for the next message.
      this.track(
        this.status(threadId, "stopped", { errorMessage: event.reason }).then(() =>
          active ? this.autoContinue(threadId, "crash") : undefined,
        ),
      );
      return;
    }
    if (event.threadId) {
      this.flushThreadDeltas(event.threadId);
      this.closeThreadReasoning(event.threadId);
      this.track(
        this.status(event.threadId, "failed", {
          errorMessage: event.message,
          ...(event.usageLimit ? { usageLimit: event.usageLimit } : {}),
        }),
      );
    }
  }

  private turnEnded(threadId: string, turnId: string): boolean {
    return this.endedTurns.get(threadId)?.includes(turnId) ?? false;
  }

  private endTurn(threadId: string, turnId: string): void {
    if (this.activeTurns.get(threadId) === turnId) this.activeTurns.delete(threadId);
    this.replyLengths.delete(turnKey(threadId, turnId));
    const ended = this.endedTurns.get(threadId) ?? [];
    ended.push(turnId);
    this.endedTurns.set(threadId, ended.slice(-MAX_ENDED_TURNS));
  }

  private recordCheckpoint(threadId: string, turnId: string): void {
    const key = turnKey(threadId, turnId);
    const start = this.turnStarts.get(key);
    if (!start || !this.checkpoints || this.deleted.has(threadId)) return;
    this.turnStarts.delete(key);
    this.track(this.checkpoints.record(threadId, turnId, start));
  }

  /** The decider sends the next queued message only if the thread is still idle with nothing open. */
  private flushQueue(threadId: string): Promise<void> {
    if (this.deleted.has(threadId)) return Promise.resolve();
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: { type: "thread.queue.flush", threadId: ThreadId.parse(threadId) },
      })
      .then(() => undefined);
  }

  private bufferDelta(threadId: string, turnId: string, text: string): void {
    if (text.length === 0) return;
    const key = `${threadId}\u0000${turnId}`;
    const pending = this.pendingDeltas.get(key);
    if (pending) {
      pending.text += text;
      return;
    }
    const timer = setTimeout(() => this.flushDelta(key), DELTA_FLUSH_MS);
    this.pendingDeltas.set(key, { threadId, turnId, text, timer });
  }

  private flushDelta(key: string): void {
    const pending = this.pendingDeltas.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDeltas.delete(key);
    this.replyLengths.set(key, (this.replyLengths.get(key) ?? 0) + pending.text.length);
    this.track(this.message(pending.threadId, "assistant", pending.text, pending.turnId));
  }

  private flushThreadDeltas(threadId: string): void {
    for (const [key, pending] of this.pendingDeltas) {
      if (pending.threadId === threadId) this.flushDelta(key);
    }
    for (const open of this.openReasoning.values()) {
      if (open.threadId === threadId) this.flushReasoning(open);
    }
  }

  private flushAllDeltas(): void {
    for (const key of [...this.pendingDeltas.keys()]) this.flushDelta(key);
    for (const open of this.openReasoning.values()) this.flushReasoning(open);
  }

  /**
   * Reasoning is recorded as a "reasoning" activity. Its first part is recorded at once, after the
   * reply text before it, so the step keeps its place and start time. Later parts are coalesced like
   * reply text, and each recorded part extends the step's text.
   */
  private reasoning(event: ReasoningEvent): void {
    if (this.turnEnded(event.threadId, event.turnId)) return;
    const key = turnKey(event.threadId, event.reasoningId);
    let open = this.openReasoning.get(key);
    if (!open) {
      this.flushThreadDeltas(event.threadId);
      open = {
        threadId: event.threadId,
        turnId: event.turnId,
        reasoningId: event.reasoningId,
        pending: "",
        sent: 0,
        truncated: false,
      };
      this.openReasoning.set(key, open);
      if (event.type === "reasoning.delta") {
        open.pending = event.text;
        this.recordReasoning(open, "running", true);
        return;
      }
    }
    if (event.type === "reasoning.delta") {
      if (event.text.length === 0) return;
      open.pending += event.text;
      const current = open;
      open.timer ??= setTimeout(() => this.flushReasoning(current), DELTA_FLUSH_MS);
      return;
    }
    // A provider that did not stream the block sends it whole when it ends.
    if (open.sent === 0 && open.pending.length === 0 && event.text) open.pending = event.text;
    this.completeReasoning(key, open);
  }

  private flushReasoning(open: OpenReasoning): void {
    clearTimeout(open.timer);
    open.timer = undefined;
    if (open.pending.length === 0) return;
    this.recordReasoning(open, "running", false);
  }

  private completeReasoning(key: string, open: OpenReasoning): void {
    clearTimeout(open.timer);
    open.timer = undefined;
    this.openReasoning.delete(key);
    this.recordReasoning(open, "completed", true);
  }

  /** A session that ends or fails leaves no reasoning running. */
  private closeThreadReasoning(threadId: string): void {
    for (const [key, open] of this.openReasoning) {
      if (open.threadId === threadId) this.completeReasoning(key, open);
    }
  }

  /** A turn that ends leaves none of its reasoning running, even when the provider never closed the block. */
  private closeTurnReasoning(threadId: string, turnId: string): void {
    for (const [key, open] of this.openReasoning) {
      if (open.threadId === threadId && open.turnId === turnId) this.completeReasoning(key, open);
    }
  }

  private recordReasoning(open: OpenReasoning, status: "running" | "completed", always: boolean): void {
    const room = MAX_REASONING_TEXT - open.sent;
    const text = open.pending.slice(0, Math.max(0, room));
    const cut = open.pending.length > text.length && !open.truncated;
    open.pending = "";
    open.sent += text.length;
    if (cut) open.truncated = true;
    // Past the cap there is nothing new to record until the block ends.
    if (!always && text.length === 0 && !cut) return;
    this.track(
      this.activity({
        type: "activity",
        threadId: ThreadId.parse(open.threadId),
        turnId: open.turnId,
        activity: {
          activityId: `reasoning:${open.reasoningId}`,
          kind: "reasoning",
          title: "Thinking",
          status,
          ...(text ? { text } : {}),
          ...(cut ? { truncated: true } : {}),
        },
      }),
    );
  }

  private fail(threadId: string, error: unknown, fallback: string): Promise<void> {
    return this.status(threadId, "failed", { errorMessage: errorText(error, fallback) });
  }

  private status(threadId: string, status: ThreadStatus, detail: StatusDetail = {}): Promise<void> {
    if (this.deleted.has(threadId)) return Promise.resolve();
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: {
          type: "thread.status",
          threadId: ThreadId.parse(threadId),
          status,
          ...(detail.turnId ? { turnId: safeTurnId(detail.turnId) } : {}),
          ...(detail.turnId?.trim() && detail.turnId.trim().length <= MAX_ACTIVITY_ID
            ? { providerTurnId: detail.turnId.trim() }
            : {}),
          ...(detail.capabilities ? { capabilities: detail.capabilities } : {}),
          ...(detail.errorMessage?.trim() ? { errorMessage: detail.errorMessage.trim().slice(0, 2_000) } : {}),
          ...(detail.usageLimit ? { usageLimit: detail.usageLimit } : {}),
        },
      })
      .then(() => undefined);
  }

  /**
   * An approval the agent asks for. In an unattended thread (a buddy's chat or job) ZLI's own tools are the
   * buddy's own, its browser, its team and its connected apps, so they never ask, at any permission; with full
   * access nothing asks. Anything else waits for the person, who answers it on a card where they talk to the
   * buddy, as in any chat.
   */
  private async approval(threadId: string, requestId: string, payload: Record<string, unknown>): Promise<void> {
    await this.request(threadId, "approval", requestId, payload);
    const thread = (await this.engine.projection()).threads.find((candidate) => candidate.threadId === threadId);
    // The person's apps: ZLI's relay judges every call itself and asks the person about anything that changes
    // something, for every agent and even from a shell, so the agent's own prompt only lets the call reach it, once.
    if (thread?.unattended && requestServer(payload) === CONNECTED_APPS_SERVER) {
      await this.respond(threadId, requestId, { approved: true });
      return;
    }
    if (
      thread?.unattended &&
      ((thread.permissionMode ?? "full-access") === "full-access" || OWN_TOOL_SERVERS.has(requestServer(payload) ?? ""))
    ) {
      await this.respond(threadId, requestId, { approved: true, scope: "session" });
      return;
    }
    await this.status(threadId, "waiting");
  }

  /**
   * The relay holds a call that changes something in the person's apps: it becomes a card in the chat that made
   * it (the worktree's working chat, newest first), and the agent is told at once that it waits on the person.
   * The card stays until they send or discard it, after the agent's turn too; ZLI then runs the call itself. A new
   * card from the same chat replaces an older one still open, so an agent that revises a draft leaves one card.
   */
  async askAppAction(call: AppsCall): Promise<AppsVerdict> {
    const projection = await this.engine.projection();
    const thread = projection.threads
      .filter((candidate) => candidate.worktreeId === call.worktreeId && !this.deleted.has(candidate.threadId))
      .filter((candidate) => ["working", "starting", "waiting"].includes(candidate.status))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
    if (!thread) return { allowed: false, reason: APP_ACTION_NO_CHAT };
    const buddy = (projection.buddies ?? []).find(
      (entry) =>
        entry.chatThreadId === thread.threadId ||
        entry.home?.worktreeId === call.worktreeId ||
        (projection.tasks ?? []).some((task) => task.buddyId === entry.buddyId && task.worktreeId === call.worktreeId),
    );
    for (const open of projection.requests ?? [])
      if (open.threadId === thread.threadId && isAppDraft(open.requestId))
        await this.dropRequest(thread.threadId, open.requestId);
    const what = describeAppsCall(call.tool, call.params);
    const email = appsCallEmail(call.tool, call.params);
    const requestId = `${APP_DRAFT_PREFIX}${randomUUID()}`;
    await this.request(thread.threadId, "approval", requestId, {
      kind: "app-action",
      title: `${buddy?.name ?? "Your agent"} wants to act in ${what.apps}`,
      apps: what.apps,
      actions: what.actions,
      ...(what.details && what.details !== "{}" ? { details: what.details } : {}),
      ...(buddy ? { buddyId: buddy.buddyId } : {}),
      ...(email ? { email } : {}),
      expiresAt: new Date(this.now() + APP_DRAFT_TTL_MS).toISOString(),
      // What ZLI runs when the person sends it; the card can change only the email's lines.
      call: { tool: call.tool, ...(call.params ? { params: call.params } : {}) },
    });
    return { held: true, reason: email ? APP_ACTION_HELD_EMAIL : APP_ACTION_HELD };
  }

  /** The person sent or discarded an app card: ZLI runs it (with their changes) and says how it went in the chat. */
  private async answerAppDraft(threadId: string, requestId: string, decision: unknown): Promise<void> {
    // A double click or a second window answers twice before the card closes: it runs once.
    if (this.appAnswers.has(requestId)) return;
    this.appAnswers.add(requestId);
    try {
      await this.runAppDraft(threadId, requestId, decision);
    } finally {
      this.appAnswers.delete(requestId);
    }
  }

  private readonly appAnswers = new Set<string>();

  private async runAppDraft(threadId: string, requestId: string, decision: unknown): Promise<void> {
    const projection = await this.engine.projection();
    const open = (projection.requests ?? []).find((request) => request.requestId === requestId);
    const payload = (open?.payload ?? {}) as {
      kind?: unknown;
      buddyId?: unknown;
      apps?: unknown;
      expiresAt?: unknown;
      call?: { tool?: unknown; params?: unknown };
    };
    if (!open || payload.kind !== "app-action") return;
    await this.dropRequest(threadId, requestId);
    const buddyId = typeof payload.buddyId === "string" ? payload.buddyId : undefined;
    if (this.draftExpired(payload.expiresAt)) {
      await this.appOutcome(buddyId, APP_DRAFT_EXPIRED);
      return;
    }
    const apps = typeof payload.apps === "string" ? payload.apps : "your apps";
    const tool = typeof payload.call?.tool === "string" ? payload.call.tool : "";
    const stored = payload.call?.params;
    const params =
      typeof stored === "object" && stored !== null && !Array.isArray(stored)
        ? (stored as Record<string, unknown>)
        : undefined;
    if (!approvalAllowed(decision) || !tool) {
      await this.appOutcome(buddyId, "Discarded. Nothing was sent.");
      return;
    }
    const edits = (decision as { edits?: unknown }).edits;
    const final = edits === undefined ? params : withEmailEdits(tool, params, edits);
    if (!final) {
      await this.appOutcome(buddyId, "Not sent: the email needs one valid address in To.");
      return;
    }
    const result = this.options.runApps
      ? await this.options.runApps(tool, final).catch(() => ({ ok: false, text: "ZLI could not run it." }))
      : { ok: false, text: "Connected apps are not running in ZLI." };
    const email = appsCallEmail(tool, final);
    const done = email ? `Sent to **${email.to}**${email.subject ? `: “${email.subject}”` : ""}.` : `Done in ${apps}.`;
    await this.appOutcome(
      buddyId,
      result.ok ? done : `That didn't go through in ${apps}: ${result.text.slice(0, 300) || "no reason given"}.`,
    );
  }

  private readonly draftSweep: ReturnType<typeof setInterval>;

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** A card's expiry has passed. A card without one (made before cards expired) never expires. */
  private draftExpired(expiresAt: unknown): boolean {
    const at = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
    return Number.isFinite(at) && at <= this.now();
  }

  /** Removes app cards past their expiry and says so in the buddy's chat. */
  async expireAppDrafts(): Promise<void> {
    const projection = await this.engine.projection();
    for (const request of projection.requests ?? []) {
      if (!isAppDraft(request.requestId) || this.appAnswers.has(request.requestId)) continue;
      const payload = request.payload as { kind?: unknown; buddyId?: unknown; expiresAt?: unknown };
      if (payload.kind !== "app-action" || !this.draftExpired(payload.expiresAt)) continue;
      await this.dropRequest(request.threadId, request.requestId);
      await this.appOutcome(typeof payload.buddyId === "string" ? payload.buddyId : undefined, APP_DRAFT_EXPIRED);
    }
  }

  /** The outcome of an app card, as a line from the buddy, so the chat and the buddy's history both show it. */
  private async appOutcome(buddyId: string | undefined, text: string): Promise<void> {
    if (!buddyId) return;
    await this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: { type: "buddy.chat.reply", buddyId, messageId: randomUUID(), text },
      } as Parameters<Engine["dispatchPromise"]>[0])
      .catch(() => undefined);
  }

  private async respond(threadId: string, requestId: string, decision: unknown): Promise<void> {
    if (isAppDraft(requestId)) {
      await this.answerAppDraft(threadId, requestId, decision);
      return;
    }
    try {
      await this.service.respondToRequest({ threadId: ThreadId.parse(threadId), requestId, decision });
      await this.resolveRequest(threadId, requestId);
    } catch (error) {
      if (await this.requestOpen(requestId)) await this.fail(threadId, error, "Approval response failed.");
    }
  }

  private async respondUserInput(threadId: string, requestId: string, answers: Record<string, string>): Promise<void> {
    try {
      await this.service.respondToUserInput({ threadId: ThreadId.parse(threadId), requestId, answers });
      await this.resolveRequest(threadId, requestId);
    } catch (error) {
      if (await this.requestOpen(requestId)) await this.fail(threadId, error, "User input response failed.");
    }
  }

  /**
   * An answer can race a Stop or a session end, which close the request. The agent has nothing left to
   * answer then, so its refusal is not a failure of the chat.
   */
  private async requestOpen(requestId: string): Promise<boolean> {
    return ((await this.engine.projection()).requests ?? []).some((request) => request.requestId === requestId);
  }

  private request(
    threadId: string,
    kind: "approval" | "user-input",
    requestId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (this.deleted.has(threadId)) return Promise.resolve();
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: {
          type: "thread.request",
          request: { requestId, threadId: ThreadId.parse(threadId), kind, payload },
        },
      })
      .then(() => undefined);
  }

  private dropRequest(threadId: string, requestId: string): Promise<boolean> {
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: { type: "thread.request.resolved", threadId: ThreadId.parse(threadId), requestId },
      })
      .then((receipt) => receipt.status !== "rejected");
  }

  /** Answering a request resumes the same turn, so the thread goes back to working, not idle. */
  private resolveRequest(threadId: string, requestId: string): Promise<void> {
    return this.dropRequest(threadId, requestId).then(async (resolved) => {
      // Already closed because the turn ended first, so the thread's status is already right.
      if (!resolved) return;
      const projection = await this.engine.projection();
      const stillWaiting = (projection.requests ?? []).some(
        (request) => request.threadId === threadId && !isAppDraft(request.requestId),
      );
      await this.status(threadId, stillWaiting ? "waiting" : "working");
    });
  }

  private activity(event: ActivityEvent): Promise<void> {
    const { activity } = event;
    const title = activity.title.trim().slice(0, MAX_ACTIVITY_TITLE) || "Tool call";
    const detail = activity.detail?.replace(/\s+$/u, "");
    const files = (activity.files ?? []).filter((file) => file.length > 0 && file.length <= 4_000).slice(0, 100);
    const turnId = event.turnId?.trim();
    const lines = activity.lines;
    const textOffset = event.turnId ? this.replyLengths.get(turnKey(event.threadId, event.turnId)) : undefined;
    if (this.deleted.has(event.threadId)) return Promise.resolve();
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: {
          type: "thread.activity",
          activity: {
            activityId: scopedActivityId(event.threadId, activity.activityId),
            threadId: ThreadId.parse(event.threadId),
            ...(turnId ? { turnId } : {}),
            kind: activity.kind,
            title,
            ...(detail ? { detail: detail.slice(-MAX_ACTIVITY_DETAIL) } : {}),
            status: activity.status,
            ...(files.length > 0 ? { files } : {}),
            ...(lines ? { lines } : {}),
            ...(activity.command?.trim() ? { command: activity.command.trim().slice(0, 2_000) } : {}),
            ...(turnId ? { textOffset: textOffset ?? 0 } : {}),
            ...(activity.connector ? { connector: activity.connector } : {}),
            ...(activity.todos ? { todos: activity.todos } : {}),
            ...(activity.input && activity.input.length > 0 ? { input: activity.input.slice(0, 30) } : {}),
            ...(activity.urls && activity.urls.length > 0 ? { urls: activity.urls.slice(0, 20) } : {}),
            ...(activity.text ? { text: activity.text.slice(0, MAX_REASONING_TEXT) } : {}),
            ...(activity.truncated ? { truncated: true } : {}),
          },
        },
      })
      .then(() => undefined);
  }

  private usage(event: UsageEvent): Promise<void> {
    if (this.deleted.has(event.threadId)) return Promise.resolve();
    const turnId = event.turnId.trim();
    if (!turnId) return Promise.resolve();
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: {
          type: "thread.usage",
          threadId: ThreadId.parse(event.threadId),
          turnId: turnId.length <= MAX_ACTIVITY_ID ? turnId : createHash("sha256").update(turnId).digest("hex"),
          usage: event.usage,
        },
      })
      .then(() => undefined);
  }

  private message(
    threadId: string,
    role: "user" | "assistant" | "system",
    text: string,
    turnId?: string,
    attachments: readonly ThreadAttachment[] = [],
  ): Promise<void> {
    if (this.deleted.has(threadId)) return Promise.resolve();
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: {
          type: "thread.message",
          message: {
            messageId: randomUUID(),
            threadId: ThreadId.parse(threadId),
            role,
            text,
            ...(turnId ? { turnId } : {}),
            ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
          },
        },
      })
      .then(() => undefined);
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function errorText(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  const message = error.message.trim() || fallback;
  return cause && !message.includes(cause) ? `${message} ${cause}` : message;
}

/** Text paths are the baseline every CLI understands; adapters with native image input also get the images. */
export function promptWithAttachments(text: string, attachments: readonly ThreadAttachment[]): string {
  if (attachments.length === 0) return text;
  const list = (entries: readonly ThreadAttachment[]) => entries.map((entry) => `- ${entry.path}`).join("\n");
  const images = attachments.filter((attachment) => attachment.mimeType !== "text/plain");
  const texts = attachments.filter((attachment) => attachment.mimeType === "text/plain");
  const sections = [text];
  if (images.length > 0) sections.push(`Attached images (read them from disk):\n${list(images)}`);
  if (texts.length > 0) sections.push(`Attached text the person pasted (read it from disk):\n${list(texts)}`);
  return sections.join("\n\n");
}

/** Provider call ids are only unique inside one session, and projected activities are keyed globally. */
function scopedActivityId(threadId: string, activityId: string): string {
  const scoped = `${threadId}:${activityId}`;
  if (scoped.length <= MAX_ACTIVITY_ID && !/[\r\n]/u.test(activityId)) return scoped;
  return `${threadId}:${createHash("sha256").update(activityId).digest("hex").slice(0, 40)}`;
}

function safeTurnId(value: string): TurnId {
  return TurnId.safeParse(value).success ? TurnId.parse(value) : TurnId.parse(randomUUID());
}

/** The tool servers ZLI itself gives every agent: the browser, ZLI's own tools, the phone, connected apps. */
/** How long an app card waits for the person, and how often ZLI looks for expired ones. */
const APP_DRAFT_TTL_MS = 24 * 60 * 60_000;
const APP_DRAFT_SWEEP_MS = 10 * 60_000;
const APP_DRAFT_EXPIRED =
  "That draft waited a day without an answer, so it expired and nothing was sent. Ask me again if you still want it.";
const APP_ACTION_HELD =
  "Not done yet: ZLI showed this to the person as a card in the chat, and it runs when they press Send there (ZLI " +
  "runs it, so don't call it again or wait for it). End your turn now with one short line saying it is ready for " +
  "them to check. If they ask for changes, make the call again with the changes; the new card replaces this one.";
const APP_ACTION_HELD_EMAIL =
  "Not sent yet: ZLI showed this email to the person as a draft card in the chat, where they can edit it and press " +
  "Send (ZLI sends it, so don't call it again or wait for it). End your turn now with one short line saying the " +
  "draft is ready for them. If they ask for changes, make the call again with the changes; the new draft replaces this one.";
const APP_ACTION_NO_CHAT =
  "This was not done: it changes something in the person's apps, and there is no open chat to ask them in. Don't retry.";

const OWN_TOOL_SERVERS = new Set<string>([
  BROWSER_MCP_SERVER,
  AGENT_MCP_SERVER,
  MOBILE_MCP_SERVER,
  CONNECTED_APPS_SERVER,
]);

/**
 * The tool server an approval is about: Codex names it, Claude and ACP agents name the tool as
 * mcp__<server>__<tool>.
 */
export function requestServer(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.serverName === "string") return payload.serverName;
  const tool = [payload.toolName, payload.tool_name, (payload.toolCall as { title?: unknown } | undefined)?.title].find(
    (value): value is string => typeof value === "string",
  );
  return tool ? /^mcp__(.+?)__/u.exec(tool)?.[1] : undefined;
}

/** An approval or question the agent is waiting on the person for. ZLI's own app cards do not count. */
function hasOpenRequest(
  projection: { requests?: ReadonlyArray<{ threadId: string; requestId: string }> | undefined },
  threadId: string,
): boolean {
  return (projection.requests ?? []).some((request) => request.threadId === threadId && !isAppDraft(request.requestId));
}
