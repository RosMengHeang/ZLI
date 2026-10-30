import { createHash, randomUUID } from "node:crypto";

import {
  type AgentToolScope,
  agentTerminalInput,
  CommandId,
  HUDDLE_REPLY_LIMIT,
  HUDDLE_REPORTS_REASON,
  HUDDLE_TYPING_REASON,
  type HuddleDelivery,
  type HuddleDeliveryStatus,
  type HuddleMember,
  type HuddlePost,
  HuddlePostId,
  type HuddleProjection,
  huddleKindWantsAnswer,
  huddleLeadWaitsFor,
  huddlePausedReason,
  huddlePostsOf,
  huddleReportsBack,
  huddleSpansProjects,
  huddleTurnLimit,
  type RuntimeCommand,
  type RuntimeEventEnvelope,
  type RuntimeProjection,
} from "@zli-v2/contracts";

import type { CommandReceipt, Engine } from "../orchestration/Engine.js";
import { huddleBatchText, huddleDeliveryText, huddleNudgeText, huddleQueueId } from "./huddleText.js";
import type { TerminalInputTracker } from "./TerminalInputTracker.js";

const STARTING_REASON = "Held until the agent finishes starting.";
export const HUDDLE_TURN_REASON =
  "Waits for the agent's current turn to end, then goes with any other new messages in one.";
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
  typed?: true;
  turn?: true;
};

/** One member's copy of one post. */
type Copy = { post: HuddlePost; delivery: HuddleDelivery };

/** Turns agents can still start for each other in a huddle during this run. */
type Budget = { left: number };

/**
 * Carries huddle messages to their members and chat agents' answers back.
 *
 * Only messages a member has to act on start a turn for it; the rest wait in its inbox. A chat gets
 * what waits for it as one message once its turn ends, and its answer to an ask or a task is that
 * next turn, posted back as a note. A terminal agent gets one message typed in; anything more while
 * it has not read or posted goes to its inbox, and several at once get one short line saying how
 * many and how to read them. Typing is held while the person has unsent input there.
 *
 * Every run reads the projection and moves each member's open copies one step. What a step needs to
 * know after a restart lives on the delivery record: the fingerprint of the text handed over, recorded
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
  private readonly sentFromQueue = new Map<string, number>();
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
            this.sentFromQueue.set(queueId, envelope.sequence);
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
    const huddles = (state.huddles ?? []).filter((huddle) => !huddle.archived);
    const posts = (state.huddlePosts ?? []).filter((post) =>
      huddles.some((huddle) => huddle.huddleId === post.huddleId),
    );
    const narrowed = this.options.agentScope() !== "all";
    for (const huddle of huddles) {
      const huddlePosts = posts.filter((post) => post.huddleId === huddle.huddleId);
      const outOfScope =
        narrowed &&
        huddleSpansProjects(
          state,
          huddle.members.map((member) => member.agentId),
        );
      const budget: Budget = { left: huddleTurnLimit(huddle) - (huddle.agentTurns ?? 0) };
      for (const member of huddle.members) {
        const copies = huddlePosts.flatMap((post) => {
          const delivery = post.deliveries.find((candidate) => candidate.agentId === member.agentId);
          return delivery ? [{ post, delivery }] : [];
        });
        if (copies.length === 0) continue;
        try {
          await this.serve(state, huddle, member, copies, huddlePosts, outOfScope, budget);
        } catch (error) {
          const reason = clip(error instanceof Error ? error.message : String(error));
          for (const copy of copies.filter((candidate) => isOpen(candidate.delivery)))
            await this.report(copy.post, member.agentId, { status: "failed", reason });
        }
      }
    }
    const waiting = new Set(
      posts.flatMap((post) =>
        post.deliveries.flatMap((delivery) =>
          delivery.status === "queued" && delivery.sentHash
            ? [huddleQueueId(post.huddleId, delivery.sentHash, delivery.agentId)]
            : [],
        ),
      ),
    );
    // Copies in one batch share a queue id, so a mark stays until no copy waits on it. A mark newer
    // than this run's snapshot may belong to a batch the snapshot does not show as queued yet.
    for (const marks of [this.sentFromQueue, this.leftQueue])
      for (const [queueId, sequence] of marks)
        if (!waiting.has(queueId) && sequence <= state.lastSequence) marks.delete(queueId);
    for (const terminalId of [...this.released])
      if (
        !posts.some((post) => post.deliveries.some((delivery) => delivery.agentId === terminalId && isOpen(delivery)))
      )
        this.released.delete(terminalId);
  }

  /** Moves one member's copies in one huddle a step. */
  private async serve(
    state: RuntimeProjection,
    huddle: HuddleProjection,
    member: HuddleMember,
    copies: readonly Copy[],
    posts: readonly HuddlePost[],
    outOfScope: boolean,
    budget: Budget,
  ): Promise<void> {
    for (const copy of copies)
      if (copy.delivery.status === "queued") await this.confirmQueued(state, huddle, member, copy, outOfScope);
    if (await this.releaseReports(huddle, member, copies, posts)) return;
    if (member.kind === "chat" && !outOfScope)
      await this.postAnswers(
        state,
        huddle,
        member,
        copies.filter((copy) => copy.delivery.status === "delivered" && copy.delivery.awaitingReply),
        posts,
      );
    let open = copies.filter((copy) => isOpen(copy.delivery));
    if (outOfScope) {
      // A terminal copy with a fingerprint was being typed when ZLI stopped; it only needs closing.
      const interrupted = (copy: Copy) => member.kind === "terminal" && copy.delivery.sentHash !== undefined;
      for (const copy of open) if (!interrupted(copy)) await this.hold(copy, HUDDLE_SCOPE_REASON);
      open = open.filter(interrupted);
    }
    if (huddle.paused) {
      for (const copy of open) if (copy.post.from.kind === "agent") await this.hold(copy, huddlePausedReason(huddle));
      open = open.filter((copy) => copy.post.from.kind === "person");
    }
    if (open.length === 0) return;
    const inbox = copies.filter((copy) => copy.delivery.status === "inbox");
    if (member.kind === "chat") await this.deliverToChat(state, huddle, member, open, inbox, posts, budget);
    else await this.deliverToTerminal(state, huddle, member, open, inbox, posts, budget);
  }

  private async deliverToChat(
    state: RuntimeProjection,
    huddle: HuddleProjection,
    member: HuddleMember,
    open: readonly Copy[],
    inbox: readonly Copy[],
    posts: readonly HuddlePost[],
    budget: Budget,
  ): Promise<void> {
    const thread = state.threads.find((candidate) => candidate.threadId === member.agentId);
    if (!thread) return;
    const intro = member.introduced ? {} : { introduced: true as const };
    // A recorded fingerprint means ZLI handed these over before it stopped, so look before sending again.
    // Without one the chat has not seen them, even if an identical message went out for other posts.
    let fresh = [...open];
    for (const sentHash of new Set(open.flatMap((copy) => copy.delivery.sentHash ?? []))) {
      const batch = open.filter((copy) => copy.delivery.sentHash === sentHash);
      const queued = inQueue(state, member.agentId, sentHash);
      if (!queued && sentMessageIndex(state, member.agentId, sentHash) < 0) continue;
      for (const copy of batch)
        await this.report(
          copy.post,
          member.agentId,
          queued
            ? { status: "queued", ...intro }
            : { status: "delivered", ...awaiting(huddle, posts, copy.post, member.agentId), ...intro },
        );
      fresh = fresh.filter((copy) => !batch.includes(copy));
    }
    if (fresh.length === 0) return;
    // Everything that arrives during a turn goes out together once it ends, as one more turn.
    if (BUSY.has(thread.status) || huddleEntryQueued(state, member.agentId)) {
      for (const copy of fresh) await this.hold(copy, HUDDLE_TURN_REASON);
      return;
    }
    const caused = countsTurn(huddle, member, fresh);
    if (caused && budget.left <= 0) {
      for (const copy of fresh) await this.hold(copy, huddlePausedReason(huddle));
      return;
    }
    const text = huddleBatchText(
      state,
      huddle,
      member,
      fresh.map((copy) => copy.post),
      inbox.map((copy) => copy.post),
      posts,
    );
    const sentHash = fingerprint(text);
    for (const copy of fresh) await this.report(copy.post, member.agentId, { status: "pending", sentHash });
    const receipt = await this.dispatch({
      type: "thread.queue",
      queueId: huddleQueueId(huddle.huddleId, sentHash, member.agentId),
      threadId: member.agentId,
      text,
    } as RuntimeCommand);
    if (receipt.status === "rejected") {
      const reason = clip(receipt.error?.message ?? "The chat did not take the message.");
      for (const copy of fresh) await this.report(copy.post, member.agentId, { status: "failed", reason });
      return;
    }
    if (caused) budget.left -= 1;
    const sentNow =
      receipt.eventTypes.includes("thread.send.requested") && !receipt.eventTypes.includes("thread.queued");
    for (const [index, copy] of fresh.entries())
      await this.report(copy.post, member.agentId, {
        status: sentNow ? "delivered" : "queued",
        sentHash,
        ...(sentNow ? awaiting(huddle, posts, copy.post, member.agentId) : {}),
        ...(index === 0 ? { ...intro, ...(caused ? { turn: true as const } : {}) } : {}),
      });
    for (const copy of inbox) await this.report(copy.post, member.agentId, { status: "delivered", sentHash });
  }

  private async deliverToTerminal(
    state: RuntimeProjection,
    huddle: HuddleProjection,
    member: HuddleMember,
    open: readonly Copy[],
    inbox: readonly Copy[],
    posts: readonly HuddlePost[],
    budget: Budget,
  ): Promise<void> {
    const intro = member.introduced ? {} : { introduced: true as const };
    const interrupted = open.filter((copy) => copy.delivery.sentHash);
    if (interrupted.length > 0) {
      // Typing started before ZLI stopped. Typing it again could run the message twice.
      for (const copy of interrupted)
        await this.report(copy.post, member.agentId, {
          status: "delivered",
          reason: INTERRUPTED_REASON,
          typed: true,
          ...intro,
        });
      return;
    }
    const terminal = state.terminals.find((candidate) => candidate.terminalId === member.agentId);
    if (!terminal) return;
    if (terminal.status === "exited" || terminal.status === "failed") {
      for (const copy of open) await this.report(copy.post, member.agentId, { status: "failed", reason: ENDED_REASON });
      return;
    }
    if (terminal.status !== "running") {
      for (const copy of open) await this.hold(copy, STARTING_REASON);
      return;
    }
    if (this.options.input.hasUnsent(member.agentId) && !this.released.has(member.agentId)) {
      for (const copy of open) await this.hold(copy, HUDDLE_TYPING_REASON);
      return;
    }
    // Until the agent reads or posts, what other agents write waits in its inbox. The person's
    // messages are still typed in.
    const quiet = member.typed ? open.filter((copy) => copy.post.from.kind === "agent") : [];
    for (const copy of quiet) await this.report(copy.post, member.agentId, { status: "inbox" });
    const typing = open.filter((copy) => !quiet.includes(copy));
    const [first] = typing;
    if (!first) return;
    const caused = countsTurn(huddle, member, typing);
    if (caused && budget.left <= 0) {
      for (const copy of typing) await this.hold(copy, huddlePausedReason(huddle));
      return;
    }
    const single = typing.length === 1;
    const text = single
      ? huddleDeliveryText(state, huddle, first.post, member, posts, inbox.length + quiet.length)
      : huddleNudgeText(
          state,
          huddle,
          member,
          [...typing, ...inbox, ...quiet].map((copy) => copy.post),
        );
    const sentHash = fingerprint(text);
    for (const copy of typing) await this.report(copy.post, member.agentId, { status: "pending", sentHash });
    this.options.writeTerminal(member.agentId, agentTerminalInput(text));
    await this.sleep(this.enterDelayMs);
    this.options.writeTerminal(member.agentId, "\r");
    if (caused) budget.left -= 1;
    for (const [index, copy] of typing.entries())
      await this.report(copy.post, member.agentId, {
        // A nudge only names the messages, so they stay unread until the agent reads the huddle.
        status: single ? "delivered" : "inbox",
        ...(index === 0 ? { typed: true as const, ...intro, ...(caused ? { turn: true as const } : {}) } : {}),
      });
  }

  private async confirmQueued(
    state: RuntimeProjection,
    huddle: HuddleProjection,
    member: HuddleMember,
    { post, delivery }: Copy,
    outOfScope: boolean,
  ): Promise<void> {
    const sentHash = delivery.sentHash ?? fingerprint(huddleDeliveryText(state, huddle, post, member, []));
    const queueId = huddleQueueId(huddle.huddleId, sentHash, delivery.agentId);
    const queued = (state.queuedMessages ?? []).find(
      (entry) => entry.threadId === delivery.agentId && fingerprint(entry.text) === sentHash,
    );
    if (queued) {
      if (!outOfScope) return;
      // Still unsent, so it can wait until Settings let the huddle span projects again.
      await this.dispatch({
        type: "thread.queue.remove",
        threadId: delivery.agentId,
        queueId: queued.queueId,
      } as RuntimeCommand);
      this.leftQueue.delete(queued.queueId);
      await this.report(post, delivery.agentId, { status: "held", reason: HUDDLE_SCOPE_REASON });
      return;
    }
    const sent = this.sentFromQueue.has(queueId) || sentMessageIndex(state, delivery.agentId, sentHash) >= 0;
    const left = this.leftQueue.has(queueId);
    if (sent) {
      await this.report(post, delivery.agentId, {
        status: "delivered",
        sentHash,
        ...awaiting(huddle, huddlePostsOf(state, huddle.huddleId), post, delivery.agentId),
      });
      return;
    }
    await this.report(post, delivery.agentId, { status: "failed", reason: left ? DEQUEUED_REASON : UNSENT_REASON });
  }

  /**
   * Reports that wait in the lead's inbox for the other workers go out once nobody owes one, such as
   * when the last worker left, or the member stopped leading. The newest starts the turn and carries
   * the rest. Says whether it changed anything, which runs the pump again.
   */
  private async releaseReports(
    huddle: HuddleProjection,
    member: HuddleMember,
    copies: readonly Copy[],
    posts: readonly HuddlePost[],
  ): Promise<boolean> {
    const waiting = copies.filter(
      (copy) => copy.delivery.status === "inbox" && copy.delivery.reason === HUDDLE_REPORTS_REASON,
    );
    if (waiting.length === 0) return false;
    if (member.agentId === huddle.lead && huddleLeadWaitsFor(huddle, posts).length > 0) return false;
    // A copy already on its way, such as the last report, carries the waiting ones with it.
    const wakes = copies.some((copy) => isOpen(copy.delivery)) ? undefined : waiting.at(-1);
    for (const copy of waiting)
      await this.report(copy.post, member.agentId, { status: copy === wakes ? "pending" : "inbox" });
    return true;
  }

  /**
   * Posts the chat's answer once the turn that read the messages is over: one answer per batch, to
   * every agent in it that asked, or to the person. The lead's answer to its workers' reports goes to
   * the person.
   */
  private async postAnswers(
    state: RuntimeProjection,
    huddle: HuddleProjection,
    member: HuddleMember,
    expecting: readonly Copy[],
    posts: readonly HuddlePost[],
  ): Promise<void> {
    if (expecting.length === 0) return;
    const thread = state.threads.find((candidate) => candidate.threadId === member.agentId);
    if (thread && BUSY.has(thread.status)) return;
    const done = { status: "delivered" as const, awaitingReply: false };
    for (const sentHash of new Set(expecting.map((copy) => copy.delivery.sentHash ?? ""))) {
      const batch = expecting.filter((copy) => (copy.delivery.sentHash ?? "") === sentHash);
      const answer = sentHash ? turnAnswer(state, member.agentId, sentHash) : "";
      const ids = new Set(batch.map((copy) => copy.post.postId));
      // After a restart between posting the answer and closing the rest of the batch.
      const answered = posts.some(
        (post) => post.auto && senderOf(post) === member.agentId && post.replyTo !== undefined && ids.has(post.replyTo),
      );
      const last = batch.at(-1);
      if (!answer || answered || !last) {
        for (const copy of batch) await this.report(copy.post, member.agentId, done);
        continue;
      }
      const askers = [
        ...new Set(
          batch.flatMap((copy) => {
            if (!huddleKindWantsAnswer(copy.post.kind)) return [];
            const asker = senderOf(copy.post);
            return asker && huddle.members.some((candidate) => candidate.agentId === asker) ? [asker] : [];
          }),
        ),
      ];
      const cut = answer.length > HUDDLE_REPLY_LIMIT;
      // Posting with replyTo clears the expected answer in the same commit, so it goes out once.
      const receipt = await this.dispatch({
        type: "huddle.post",
        huddleId: huddle.huddleId,
        postId: HuddlePostId.parse(randomUUID()),
        from: member.agentId,
        to: askers.length > 0 ? askers : "person",
        kind: "note",
        text: cut ? answer.slice(0, HUDDLE_REPLY_LIMIT) : answer,
        replyTo: last.post.postId,
        auto: true,
        ...(cut ? { cut: true } : {}),
      });
      for (const copy of batch)
        if (copy !== last || receipt.status === "rejected") await this.report(copy.post, member.agentId, done);
    }
  }

  private async hold({ post, delivery }: Copy, reason: string): Promise<void> {
    if (delivery.status !== "held" || delivery.reason !== reason)
      await this.report(post, delivery.agentId, { status: "held", reason });
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

function inQueue(state: RuntimeProjection, threadId: string, sentHash: string): boolean {
  return (state.queuedMessages ?? []).some(
    (entry) => entry.threadId === threadId && fingerprint(entry.text) === sentHash,
  );
}

/** A huddle batch waits in the chat's queue, so the next one waits for it to go out. */
function huddleEntryQueued(state: RuntimeProjection, threadId: string): boolean {
  return (state.queuedMessages ?? []).some(
    (entry) => entry.threadId === threadId && entry.queueId.startsWith("huddle:"),
  );
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

function senderOf(post: HuddlePost): string | undefined {
  return post.from.kind === "agent" ? post.from.agentId : undefined;
}

/** The member owes an answer: to an ask, task, or blocker, or as the lead, to its workers' reports. */
function awaiting(
  huddle: HuddleProjection,
  posts: readonly HuddlePost[],
  post: HuddlePost,
  agentId: string,
): { awaitingReply?: true } {
  const owed = huddleKindWantsAnswer(post.kind) || (agentId === huddle.lead && huddleReportsBack(huddle, posts, post));
  return owed ? { awaitingReply: true } : {};
}

/**
 * Whether a turn counts toward the pause: agents started it, and with a lead, it is not the lead
 * handing out work. What comes back to the lead, or passes between workers, ends a round.
 */
function countsTurn(huddle: HuddleProjection, member: HuddleMember, waking: readonly Copy[]): boolean {
  if (waking.some((copy) => copy.post.from.kind === "person")) return false;
  if (huddle.lead === undefined || member.agentId === huddle.lead) return true;
  return !waking.some((copy) => senderOf(copy.post) === huddle.lead);
}

function isOpen(delivery: HuddleDelivery): boolean {
  return delivery.status === "pending" || delivery.status === "held";
}

function clip(reason: string): string {
  return reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 3)}...` : reason;
}
