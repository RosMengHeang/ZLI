import { createHash, randomUUID } from "node:crypto";

import {
  type AgentToolScope,
  agentTerminalInput,
  CommandId,
  HUDDLE_REPLY_LIMIT,
  HUDDLE_TYPING_REASON,
  type HuddleDelivery,
  type HuddleDeliveryStatus,
  type HuddleMember,
  type HuddlePost,
  HuddlePostId,
  type HuddleProjection,
  huddleSpansProjects,
  type RuntimeCommand,
  type RuntimeEventEnvelope,
  type RuntimeProjection,
} from "@zli-v2/contracts";

import type { CommandReceipt, Engine } from "../orchestration/Engine.js";
import { huddleDeliveryText, huddleQueueId } from "./huddleText.js";
import type { TerminalInputTracker } from "./TerminalInputTracker.js";

const STARTING_REASON = "Held until the agent finishes starting.";
const ENDED_REASON = "The terminal agent exited before this went out.";
const DEQUEUED_REASON = "Taken out of the chat's queue before it was sent.";
const UNSENT_REASON = "Left the chat's queue while ZLI was closed, and the chat has no record of getting it.";
const INTERRUPTED_REASON =
  "ZLI stopped while typing this, so it was not typed again. Check the terminal to see whether it arrived.";
export const HUDDLE_SCOPE_REASON =
  "Held because Settings keep agents to their own project, and this huddle has agents from more than one.";
const MAX_REASON = 300;
const BUSY = new Set(["starting", "working", "waiting"]);

export type HuddleReactorOptions = {
  input: TerminalInputTracker;
  writeTerminal(terminalId: string, data: string): void;
  /** The Settings choice of which agents others can reach. Read on every run, so a change applies at once. */
  agentScope(): AgentToolScope;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Agent CLIs treat text and Enter that arrive in one read as a paste, which would not submit. */
  enterDelayMs?: number;
};

type DeliveryChange = {
  status: HuddleDeliveryStatus;
  reason?: string;
  awaitingReply?: boolean;
  introduced?: true;
  sentHash?: string;
};

/**
 * Carries huddle messages to their members and chat agents' answers back.
 *
 * Chats get messages through their queue, so a busy chat reads them after its turn. The answer to an
 * ask or a task is the chat's next turn, posted back as a note. Terminal agents get messages typed
 * in, held while the person has unsent typing there, and answer with the huddle tool themselves.
 *
 * Every run reads the projection and moves each open delivery one step. What a step needs to know
 * after a restart lives on the delivery record: the fingerprint of the text handed over, recorded
 * before a terminal is typed into, so a restart neither types a message twice nor loses a chat's answer.
 */
export class HuddleReactor {
  private readonly unsubscribe: Array<() => void>;
  private running: Promise<void> | undefined;
  private dirty = false;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly enterDelayMs: number;
  /**
   * Huddle entries a chat took out of its queue and sent, by queue id. The chat records the message a
   * moment after the send, so this bridges that gap; after a restart the recorded message stands in.
   */
  private readonly sentFromQueue = new Set<string>();
  /** When a huddle entry left a chat's queue, sent or not, by queue id. */
  private readonly leftQueue = new Map<string, number>();
  /** Terminals whose held messages the person asked to type now. */
  private readonly released = new Set<string>();

  constructor(
    private readonly engine: Engine,
    private readonly options: HuddleReactorOptions,
  ) {
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.enterDelayMs = options.enterDelayMs ?? 150;
    this.unsubscribe = [
      engine.subscribe((envelope) => this.observe(envelope)),
      options.input.onChange(() => this.schedule()),
    ];
    this.schedule();
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }

  /** Runs again, for a change the event log does not show, such as Settings. */
  refresh(): void {
    this.schedule();
  }

  async waitForIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  private observe(envelope: RuntimeEventEnvelope): void {
    const event = envelope.event;
    switch (event.type) {
      case "thread.queue.removed":
        if (!event.queueId.startsWith("huddle:")) return;
        this.leftQueue.set(event.queueId, envelope.sequence);
        break;
      case "thread.send.requested":
        // A queued message is sent as its removal followed at once by the send, in one commit.
        for (const [queueId, sequence] of this.leftQueue)
          if (sequence === envelope.sequence - 1 && queueId.endsWith(`:${event.threadId}`))
            this.sentFromQueue.add(queueId);
        return;
      case "thread.status.changed":
        if (event.status !== "idle" && event.status !== "stopped" && event.status !== "failed") return;
        break;
      case "huddle.release.requested":
        this.released.add(event.agentId);
        break;
      case "terminal.status.changed":
      case "session.deleted":
        break;
      default:
        if (!event.type.startsWith("huddle.")) return;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = (async () => {
      try {
        do {
          this.dirty = false;
          await this.pump();
        } while (this.dirty);
      } finally {
        this.running = undefined;
      }
    })();
  }

  private async pump(): Promise<void> {
    const state = await this.engine.projection();
    const huddles = new Map(
      (state.huddles ?? []).filter((huddle) => !huddle.archived).map((huddle) => [huddle.huddleId, huddle]),
    );
    const posts = (state.huddlePosts ?? []).filter((post) => huddles.has(post.huddleId));
    const narrowed = this.options.agentScope() !== "all";
    const blocked = new Set(
      [...huddles.values()]
        .filter(
          (huddle) =>
            narrowed &&
            huddleSpansProjects(
              state,
              huddle.members.map((member) => member.agentId),
            ),
        )
        .map((huddle) => huddle.huddleId),
    );
    // Introductions made during this run, which the snapshot does not show yet.
    const introduced = new Set<string>();
    for (const post of posts) {
      const huddle = huddles.get(post.huddleId) as HuddleProjection;
      const huddlePosts = posts.filter((candidate) => candidate.huddleId === huddle.huddleId);
      const outOfScope = blocked.has(huddle.huddleId);
      for (const delivery of post.deliveries) {
        const found = huddle.members.find((member) => member.agentId === delivery.agentId);
        if (!found) continue;
        const introKey = `${huddle.huddleId}:${found.agentId}`;
        const member: HuddleMember = introduced.has(introKey) ? { ...found, introduced: true } : found;
        try {
          if (delivery.status === "pending" || delivery.status === "held") {
            if (post.from.kind === "agent" && huddle.paused) continue;
            if (outOfScope && !(member.kind === "terminal" && delivery.sentHash)) {
              await this.hold(post, delivery, HUDDLE_SCOPE_REASON);
              continue;
            }
            const didIntroduce =
              member.kind === "chat"
                ? await this.deliverToChat(state, huddle, post, member, delivery, huddlePosts)
                : await this.deliverToTerminal(state, huddle, post, member, delivery, huddlePosts);
            if (didIntroduce) introduced.add(introKey);
          } else if (delivery.status === "queued")
            await this.confirmQueued(state, huddle, post, member, delivery, huddlePosts, outOfScope);
          else if (delivery.status === "delivered" && delivery.awaitingReply && !outOfScope)
            await this.postAnswer(state, huddle, post, delivery);
        } catch (error) {
          await this.report(post, delivery.agentId, {
            status: "failed",
            reason: clip(error instanceof Error ? error.message : String(error)),
          });
        }
      }
    }
    for (const terminalId of [...this.released])
      if (
        !posts.some((post) => post.deliveries.some((delivery) => delivery.agentId === terminalId && isOpen(delivery)))
      )
        this.released.delete(terminalId);
  }

  /** Returns whether the text introduced the huddle to the member. */
  private async deliverToChat(
    state: RuntimeProjection,
    huddle: HuddleProjection,
    post: HuddlePost,
    member: HuddleMember,
    delivery: HuddleDelivery,
    posts: readonly HuddlePost[],
  ): Promise<boolean> {
    if (!state.threads.some((thread) => thread.threadId === member.agentId)) return false;
    const queueId = huddleQueueId(post.postId, member.agentId);
    const intro = member.introduced ? {} : { introduced: true as const };
    // A recorded fingerprint means ZLI handed this over before it stopped, so look before sending again.
    // Without one the chat has not seen it, even if an identical message went out for another post.
    if (delivery.sentHash) {
      const sentHash = delivery.sentHash;
      if ((state.queuedMessages ?? []).some((queued) => queued.queueId === queueId)) {
        await this.report(post, member.agentId, { status: "queued", ...intro });
        return !member.introduced;
      }
      if (sentMessageIndex(state, member.agentId, sentHash) >= 0) {
        await this.report(post, member.agentId, { status: "delivered", ...awaiting(post), ...intro });
        return !member.introduced;
      }
    }
    const text = huddleDeliveryText(state, huddle, post, member, posts);
    const sentHash = fingerprint(text);
    await this.report(post, member.agentId, { status: "pending", sentHash });
    const receipt = await this.dispatch({
      type: "thread.queue",
      queueId,
      threadId: member.agentId,
      text,
    } as RuntimeCommand);
    if (receipt.status === "rejected") {
      await this.report(post, member.agentId, {
        status: "failed",
        reason: clip(receipt.error?.message ?? "The chat did not take the message."),
      });
      return false;
    }
    const sentNow =
      receipt.eventTypes.includes("thread.send.requested") && !receipt.eventTypes.includes("thread.queued");
    await this.report(post, member.agentId, {
      status: sentNow ? "delivered" : "queued",
      sentHash,
      ...(sentNow ? awaiting(post) : {}),
      ...intro,
    });
    return !member.introduced;
  }

  private async deliverToTerminal(
    state: RuntimeProjection,
    huddle: HuddleProjection,
    post: HuddlePost,
    member: HuddleMember,
    delivery: HuddleDelivery,
    posts: readonly HuddlePost[],
  ): Promise<boolean> {
    const intro = member.introduced ? {} : { introduced: true as const };
    if (delivery.sentHash) {
      // Typing started before ZLI stopped. Typing it again could run the message twice.
      await this.report(post, member.agentId, { status: "delivered", reason: INTERRUPTED_REASON, ...intro });
      return !member.introduced;
    }
    const terminal = state.terminals.find((candidate) => candidate.terminalId === member.agentId);
    if (!terminal) return false;
    if (terminal.status === "exited" || terminal.status === "failed") {
      await this.report(post, member.agentId, { status: "failed", reason: ENDED_REASON });
      return false;
    }
    if (terminal.status !== "running") return this.hold(post, delivery, STARTING_REASON);
    if (this.options.input.hasUnsent(member.agentId) && !this.released.has(member.agentId))
      return this.hold(post, delivery, HUDDLE_TYPING_REASON);
    const text = huddleDeliveryText(state, huddle, post, member, posts);
    await this.report(post, member.agentId, { status: "pending", sentHash: fingerprint(text) });
    this.options.writeTerminal(member.agentId, agentTerminalInput(text));
    await this.sleep(this.enterDelayMs);
    this.options.writeTerminal(member.agentId, "\r");
    await this.report(post, member.agentId, { status: "delivered", ...intro });
    return !member.introduced;
  }

  private async confirmQueued(
    state: RuntimeProjection,
    huddle: HuddleProjection,
    post: HuddlePost,
    member: HuddleMember,
    delivery: HuddleDelivery,
    posts: readonly HuddlePost[],
    outOfScope: boolean,
  ): Promise<void> {
    const queueId = huddleQueueId(post.postId, delivery.agentId);
    if ((state.queuedMessages ?? []).some((queued) => queued.queueId === queueId)) {
      if (!outOfScope) return;
      // Still unsent, so it can wait until Settings let the huddle span projects again.
      await this.dispatch({ type: "thread.queue.remove", threadId: delivery.agentId, queueId } as RuntimeCommand);
      this.leftQueue.delete(queueId);
      await this.report(post, delivery.agentId, { status: "held", reason: HUDDLE_SCOPE_REASON });
      return;
    }
    const sentHash = delivery.sentHash ?? fingerprint(huddleDeliveryText(state, huddle, post, member, posts));
    const sent = this.sentFromQueue.has(queueId) || sentMessageIndex(state, delivery.agentId, sentHash) >= 0;
    const left = this.leftQueue.has(queueId);
    this.sentFromQueue.delete(queueId);
    this.leftQueue.delete(queueId);
    if (sent) {
      await this.report(post, delivery.agentId, { status: "delivered", sentHash, ...awaiting(post) });
      return;
    }
    await this.report(post, delivery.agentId, { status: "failed", reason: left ? DEQUEUED_REASON : UNSENT_REASON });
  }

  /** Posts the chat's answer once the turn that read the message is over. */
  private async postAnswer(
    state: RuntimeProjection,
    huddle: HuddleProjection,
    post: HuddlePost,
    delivery: HuddleDelivery,
  ): Promise<void> {
    const thread = state.threads.find((candidate) => candidate.threadId === delivery.agentId);
    if (thread && BUSY.has(thread.status)) return;
    const done = { status: "delivered" as const, awaitingReply: false };
    const answer = delivery.sentHash ? turnAnswer(state, delivery.agentId, delivery.sentHash) : "";
    if (!answer) {
      await this.report(post, delivery.agentId, done);
      return;
    }
    const cut = answer.length > HUDDLE_REPLY_LIMIT;
    const asker = post.from.kind === "agent" ? post.from.agentId : undefined;
    // Posting with replyTo clears the expected answer in the same commit, so it goes out once.
    const receipt = await this.dispatch({
      type: "huddle.post",
      huddleId: huddle.huddleId,
      postId: HuddlePostId.parse(randomUUID()),
      from: delivery.agentId,
      to: asker && huddle.members.some((member) => member.agentId === asker) ? [asker] : "person",
      kind: "note",
      text: cut ? answer.slice(0, HUDDLE_REPLY_LIMIT) : answer,
      replyTo: post.postId,
      auto: true,
      ...(cut ? { cut: true } : {}),
    });
    if (receipt.status === "rejected") await this.report(post, delivery.agentId, done);
  }

  private async hold(post: HuddlePost, delivery: HuddleDelivery, reason: string): Promise<false> {
    if (delivery.status !== "held" || delivery.reason !== reason)
      await this.report(post, delivery.agentId, { status: "held", reason });
    return false;
  }

  private async report(post: HuddlePost, agentId: string, change: DeliveryChange): Promise<void> {
    await this.dispatch({ type: "huddle.delivery", huddleId: post.huddleId, postId: post.postId, agentId, ...change });
  }

  private dispatch(command: RuntimeCommand): Promise<CommandReceipt> {
    return this.engine.dispatchPromise({ protocolVersion: 1, commandId: CommandId.parse(randomUUID()), command });
  }
}

/** A short fingerprint of the exact text a member got, kept on the delivery instead of the text. */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Where the chat recorded the message with this fingerprint, or -1. */
function sentMessageIndex(state: RuntimeProjection, threadId: string, sentHash: string): number {
  const messages = (state.messages ?? []).filter((message) => message.threadId === threadId);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && message.text.startsWith("Huddle ") && fingerprint(message.text) === sentHash)
      return index;
  }
  return -1;
}

/** The assistant text between the sent message and the next message from the person. */
function turnAnswer(state: RuntimeProjection, threadId: string, sentHash: string): string {
  const start = sentMessageIndex(state, threadId, sentHash);
  if (start < 0) return "";
  const messages = (state.messages ?? []).filter((message) => message.threadId === threadId);
  const parts: string[] = [];
  for (const message of messages.slice(start + 1)) {
    if (message.role === "user") break;
    if (message.role === "assistant" && message.text.trim()) parts.push(message.text.trim());
  }
  return parts.join("\n\n");
}

function awaiting(post: HuddlePost): { awaitingReply?: true } {
  return post.kind !== "note" ? { awaitingReply: true } : {};
}

function isOpen(delivery: HuddleDelivery): boolean {
  return delivery.status === "pending" || delivery.status === "held";
}

function clip(reason: string): string {
  return reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 3)}...` : reason;
}
