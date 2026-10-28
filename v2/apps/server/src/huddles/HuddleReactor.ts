import { randomUUID } from "node:crypto";

import {
  CommandId,
  HUDDLE_REPLY_LIMIT,
  HUDDLE_TYPING_REASON,
  type HuddleDelivery,
  type HuddleDeliveryStatus,
  type HuddleMember,
  type HuddlePost,
  HuddlePostId,
  type HuddleProjection,
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
const UNCONFIRMED_REASON = "ZLI restarted before it could confirm this was sent.";
const MAX_REASON = 300;

export type HuddleReactorOptions = {
  input: TerminalInputTracker;
  writeTerminal(terminalId: string, data: string): void;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Agent CLIs treat text and Enter that arrive in one read as a paste, which would not submit. */
  enterDelayMs?: number;
};

/** A chat delivery that went out: the event sequence of its send, and the exact text sent. */
type Sent = { sequence: number; text: string };

type DeliveryChange = {
  status: HuddleDeliveryStatus;
  reason?: string;
  awaitingReply?: boolean;
  introduced?: true;
};

/**
 * Carries huddle messages to their members and chat agents' answers back.
 *
 * Chats get messages through their queue, so a busy chat reads them after its turn. The answer to an
 * ask or a task is the chat's next turn, posted back as a note. Terminal agents get messages typed
 * in, held while the person has unsent typing there, and answer with the huddle tool themselves.
 *
 * Every run reads the projection and moves each open delivery one step, so a missed event or a
 * restart only delays a message instead of losing it.
 */
export class HuddleReactor {
  private readonly unsubscribe: Array<() => void>;
  private running: Promise<void> | undefined;
  private dirty = false;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly enterDelayMs: number;
  /** Chat deliveries that went out and whose answer is still expected, by delivery key. */
  private readonly sent = new Map<string, Sent>();
  /** Huddle entries a chat took out of its queue and sent, by queue id. */
  private readonly sentFromQueue = new Map<string, Sent>();
  /** When a huddle entry left a chat's queue, sent or not, by queue id. */
  private readonly leftQueue = new Map<string, number>();
  /** The sequence of each chat's latest finished turn. */
  private readonly turnEnded = new Map<string, number>();
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
            this.sentFromQueue.set(queueId, { sequence: envelope.sequence, text: event.text });
        return;
      case "thread.status.changed":
        if (event.status !== "idle" && event.status !== "stopped" && event.status !== "failed") return;
        this.turnEnded.set(event.threadId, envelope.sequence);
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
    // Introductions made during this run, which the snapshot does not show yet.
    const introduced = new Set<string>();
    for (const post of posts) {
      const huddle = huddles.get(post.huddleId) as HuddleProjection;
      const huddlePosts = posts.filter((candidate) => candidate.huddleId === huddle.huddleId);
      for (const delivery of post.deliveries) {
        const found = huddle.members.find((member) => member.agentId === delivery.agentId);
        if (!found) continue;
        const introKey = `${huddle.huddleId}:${found.agentId}`;
        const member: HuddleMember = introduced.has(introKey) ? { ...found, introduced: true } : found;
        try {
          if (delivery.status === "pending" || delivery.status === "held") {
            if (post.from.kind === "agent" && huddle.paused) continue;
            const didIntroduce =
              member.kind === "chat"
                ? await this.deliverToChat(state, huddle, post, member, huddlePosts)
                : await this.deliverToTerminal(state, huddle, post, member, delivery, huddlePosts);
            if (didIntroduce) introduced.add(introKey);
          } else if (delivery.status === "queued") await this.confirmQueued(state, post, delivery);
          else if (delivery.status === "delivered" && delivery.awaitingReply)
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
    posts: readonly HuddlePost[],
  ): Promise<boolean> {
    if (!state.threads.some((thread) => thread.threadId === member.agentId)) return false;
    const text = huddleDeliveryText(state, huddle, post, member, posts);
    const receipt = await this.dispatch({
      type: "thread.queue",
      queueId: huddleQueueId(post.postId, member.agentId),
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
    const intro = member.introduced ? {} : { introduced: true as const };
    if (!receipt.eventTypes.includes("thread.send.requested") || receipt.eventTypes.includes("thread.queued")) {
      await this.report(post, member.agentId, { status: "queued", ...intro });
      return !member.introduced;
    }
    this.sent.set(deliveryKey(post, member.agentId), { sequence: receipt.lastSequence ?? 0, text });
    await this.report(post, member.agentId, {
      status: "delivered",
      ...(post.kind !== "note" ? { awaitingReply: true } : {}),
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
    const terminal = state.terminals.find((candidate) => candidate.terminalId === member.agentId);
    if (!terminal) return false;
    const hold = async (reason: string) => {
      if (delivery.status !== "held" || delivery.reason !== reason)
        await this.report(post, member.agentId, { status: "held", reason });
      return false;
    };
    if (terminal.status === "exited" || terminal.status === "failed") {
      await this.report(post, member.agentId, { status: "failed", reason: ENDED_REASON });
      return false;
    }
    if (terminal.status !== "running") return hold(STARTING_REASON);
    if (this.options.input.hasUnsent(member.agentId) && !this.released.has(member.agentId))
      return hold(HUDDLE_TYPING_REASON);
    const text = huddleDeliveryText(state, huddle, post, member, posts);
    this.options.writeTerminal(member.agentId, /[\r\n]/u.test(text) ? `\u001b[200~${text}\u001b[201~` : text);
    await this.sleep(this.enterDelayMs);
    this.options.writeTerminal(member.agentId, "\r");
    await this.report(post, member.agentId, {
      status: "delivered",
      ...(member.introduced ? {} : { introduced: true as const }),
    });
    return !member.introduced;
  }

  private async confirmQueued(state: RuntimeProjection, post: HuddlePost, delivery: HuddleDelivery): Promise<void> {
    const queueId = huddleQueueId(post.postId, delivery.agentId);
    if ((state.queuedMessages ?? []).some((queued) => queued.queueId === queueId)) return;
    const sent = this.sentFromQueue.get(queueId);
    const left = this.leftQueue.has(queueId);
    this.sentFromQueue.delete(queueId);
    this.leftQueue.delete(queueId);
    if (sent) {
      this.sent.set(deliveryKey(post, delivery.agentId), sent);
      await this.report(post, delivery.agentId, {
        status: "delivered",
        ...(post.kind !== "note" ? { awaitingReply: true } : {}),
      });
      return;
    }
    await this.report(post, delivery.agentId, {
      status: "failed",
      reason: left ? DEQUEUED_REASON : UNCONFIRMED_REASON,
    });
  }

  /** Posts the chat's answer once the turn that read the message is over. */
  private async postAnswer(
    state: RuntimeProjection,
    huddle: HuddleProjection,
    post: HuddlePost,
    delivery: HuddleDelivery,
  ): Promise<void> {
    const key = deliveryKey(post, delivery.agentId);
    const sent = this.sent.get(key);
    const thread = state.threads.find((candidate) => candidate.threadId === delivery.agentId);
    const done = { status: "delivered" as const, awaitingReply: false };
    if (!sent) {
      // Sent before a restart: the turn it started is gone, so no answer is coming.
      if (thread?.status !== "working" && thread?.status !== "waiting") await this.report(post, delivery.agentId, done);
      return;
    }
    const ended = this.turnEnded.get(delivery.agentId);
    if (ended === undefined || ended < sent.sequence) return;
    this.sent.delete(key);
    const answer = turnAnswer(state, delivery.agentId, sent.text);
    if (!answer) {
      await this.report(post, delivery.agentId, done);
      return;
    }
    const cut = answer.length > HUDDLE_REPLY_LIMIT;
    const asker = post.from.kind === "agent" ? post.from.agentId : undefined;
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

  private async report(post: HuddlePost, agentId: string, change: DeliveryChange): Promise<void> {
    await this.dispatch({ type: "huddle.delivery", huddleId: post.huddleId, postId: post.postId, agentId, ...change });
  }

  private dispatch(command: RuntimeCommand): Promise<CommandReceipt> {
    return this.engine.dispatchPromise({ protocolVersion: 1, commandId: CommandId.parse(randomUUID()), command });
  }
}

/** The assistant text between the sent message and the next message from the person. */
function turnAnswer(state: RuntimeProjection, threadId: string, sentText: string): string {
  const messages = (state.messages ?? []).filter((message) => message.threadId === threadId);
  let start = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && message.text === sentText) {
      start = index;
      break;
    }
  }
  if (start < 0) return "";
  const parts: string[] = [];
  for (const message of messages.slice(start + 1)) {
    if (message.role === "user") break;
    if (message.role === "assistant" && message.text.trim()) parts.push(message.text.trim());
  }
  return parts.join("\n\n");
}

function deliveryKey(post: HuddlePost, agentId: string): string {
  return `${post.postId}:${agentId}`;
}

function isOpen(delivery: HuddleDelivery): boolean {
  return delivery.status === "pending" || delivery.status === "held";
}

function clip(reason: string): string {
  return reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 3)}...` : reason;
}
