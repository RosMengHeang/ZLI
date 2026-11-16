import {
  agentNameTaken,
  type BuddyMessage,
  type BuddyProjection,
  buddyNamed,
  CommandId,
  guessProject,
  type ProjectProjection,
  type ProviderDiscovery,
  type RuntimeCommand,
  type RuntimeEventEnvelope,
  type RuntimeProjection,
} from "@zli-v2/contracts";

import type { CommandReceipt, Engine } from "../orchestration/Engine.js";
import { candidatesFor, pickEngine, trackRecords } from "./autopick.js";
import { chatBrief, parseChatReply, projectNamed, senderName } from "./chat.js";
import { stableId } from "./TaskReactor.js";

export type BuddyChatReactorOptions = {
  providers: () => Promise<readonly ProviderDiscovery[]>;
  now?: () => Date;
  onError?: (error: unknown) => void;
};

/** Messages a fresh chat gets from before, so a restarted chat still knows the conversation. */
const HISTORY = 16;

/**
 * Runs each buddy's chat with the person. The chat is a hidden, read-only agent chat in a project
 * checkout: the person's messages go to it with a brief, and its finished replies come back as the
 * buddy's messages. A reply can start jobs and keep notes about the person, through markers that ZLI
 * reads out before the person sees the reply.
 *
 * Every command it sends has an id made from the message it answers, so a restart never repeats one.
 */
export class BuddyChatReactor {
  private readonly unsubscribe: () => void;
  private running: Promise<void> | undefined;
  private dirty = false;

  constructor(
    private readonly engine: Engine,
    private readonly options: BuddyChatReactorOptions,
  ) {
    this.unsubscribe = engine.subscribe((envelope) => this.observe(envelope));
    this.schedule();
  }

  stop(): void {
    this.unsubscribe();
  }

  async waitForIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  private observe(envelope: RuntimeEventEnvelope): void {
    const type = envelope.event.type;
    if (type.startsWith("buddy.chat.") || type.startsWith("thread.") || type === "runtime.ready") this.schedule();
  }

  private schedule(): void {
    this.dirty = true;
    if (this.running) return;
    this.running = this.loop().finally(() => {
      this.running = undefined;
    });
  }

  private async loop(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      try {
        const state = await this.engine.projection();
        for (const buddy of state.buddies ?? []) if (!buddy.archived) await this.tend(state, buddy);
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }

  private async tend(state: RuntimeProjection, buddy: BuddyProjection): Promise<void> {
    const messages = (state.buddyMessages ?? []).filter((message) => message.buddyId === buddy.buddyId);
    const lastReply = messages.findLastIndex((message) => message.role === "buddy");
    const waiting = messages.slice(lastReply + 1).filter((message) => message.role === "you");
    const thread = state.threads.find((candidate) => candidate.threadId === buddy.chatThreadId);
    if (thread && waiting.length > 0) await this.collect(state, buddy, thread.threadId, waiting);
    if (waiting.length === 0) return;
    const usable =
      thread?.unattended &&
      thread.status !== "failed" &&
      thread.status !== "stopped" &&
      state.worktrees.some((worktree) => worktree.worktreeId === thread.worktreeId && worktree.status === "ready");
    // A chat started before chats ran unattended can be stuck waiting on a prompt nobody sees: end it.
    if (thread && !thread.unattended && thread.status !== "failed" && thread.status !== "stopped")
      await this.dispatch(
        { type: "thread.stop", threadId: thread.threadId } as RuntimeCommand,
        `buddy-chat-retire:${thread.threadId}`,
      );
    const threadId = usable ? thread.threadId : await this.open(state, buddy, waiting[0] as BuddyMessage);
    if (!threadId) return;
    const fresh = !(state.messages ?? []).some((message) => message.threadId === threadId);
    for (const message of waiting) {
      const guess = guessProject(message.text, state.projects, state.tasks ?? [], buddy.buddyId, undefined);
      const history = fresh ? messages.slice(0, messages.indexOf(message)).slice(-HISTORY) : undefined;
      await this.dispatch(
        {
          type: "thread.queue",
          threadId,
          queueId: `buddy-chat:${message.messageId}`,
          text: message.from
            ? `${senderName(state, message)}, your teammate, says:\n${message.text}\n\nAnswer them in your reply. ZLI passes it back to them.`
            : message.text,
          context: chatBrief({ buddy, state, guess, ...(history ? { history } : {}) }),
        } as RuntimeCommand,
        `buddy-chat-queue:${message.messageId}:${threadId}`,
      );
    }
  }

  /** Starts a chat for the buddy in a project checkout: where it last worked, or the first project. */
  private async open(
    state: RuntimeProjection,
    buddy: BuddyProjection,
    first: BuddyMessage,
  ): Promise<string | undefined> {
    const last = (state.tasks ?? []).findLast((task) => task.buddyId === buddy.buddyId);
    const project = state.projects.find((entry) => entry.projectId === last?.projectId) ?? state.projects[0];
    if (!project) {
      await this.reply(buddy, `no-project:${first.messageId}`, "Add a project in the sidebar first, then I can help.");
      return undefined;
    }
    const checkout = await this.checkout(state, project);
    if (!checkout) {
      await this.reply(buddy, `no-checkout:${first.messageId}`, `I could not open ${project.name}.`);
      return undefined;
    }
    const pick = pickEngine({
      buddy,
      profile: { kind: "question", size: "s", risk: "low", needsBrowser: false },
      candidates: candidatesFor(await this.options.providers().catch(() => []), buddy, undefined),
      records: trackRecords(state.tasks ?? []),
      quality: state.buddySettings?.quality ?? "balanced",
      now: (this.options.now?.() ?? new Date()).toISOString(),
    });
    if (!pick) {
      await this.reply(
        buddy,
        `no-agent:${first.messageId}`,
        "No agent is set up to answer. Sign in to one in Settings.",
      );
      return undefined;
    }
    const threadId = stableId(`buddy-chat:${buddy.buddyId}:${first.messageId}:${buddy.chatThreadId ?? ""}`);
    const name = `${buddy.name} chat`;
    const receipt = await this.dispatch(
      {
        type: "thread.start",
        threadId,
        worktreeId: checkout.worktreeId,
        provider: pick.provider,
        cwd: checkout.path,
        permissionMode: "read-only",
        unattended: true,
        ...(pick.model ? { model: pick.model } : {}),
        ...(pick.accountId ? { accountId: pick.accountId } : {}),
        ...(agentNameTaken(state, { projectId: checkout.projectId, name }) ? {} : { name }),
        shareWorktree: true,
      } as RuntimeCommand,
      `buddy-chat-thread:${threadId}`,
    );
    if (receipt.status === "rejected") {
      await this.reply(
        buddy,
        `start-failed:${first.messageId}`,
        `I could not start: ${receipt.error?.message ?? "the agent did not open"}.`,
      );
      return undefined;
    }
    await this.dispatch(
      { type: "buddy.chat.thread", buddyId: buddy.buddyId, threadId } as RuntimeCommand,
      `buddy-chat-thread-set:${threadId}`,
    );
    return threadId;
  }

  /** The project's own folder as a worktree, made the way a new chat makes it when there is none yet. */
  private async checkout(state: RuntimeProjection, project: ProjectProjection) {
    const ready = (current: RuntimeProjection) =>
      current.worktrees.find(
        (worktree) =>
          worktree.projectId === project.projectId && worktree.kind === "checkout" && worktree.status === "ready",
      );
    const found = ready(state);
    if (found) return found;
    await this.dispatch(
      {
        type: "worktree.import",
        worktreeId: stableId(`buddy-chat-checkout:${project.projectId}`),
        projectId: project.projectId,
        path: project.path,
        branch: "HEAD",
        kind: "checkout",
      } as RuntimeCommand,
      `buddy-chat-checkout:${project.projectId}`,
    );
    return ready(await this.engine.projection());
  }

  /** Brings the chat's finished answer back as the buddy's message, and does what it asked for. */
  private async collect(
    state: RuntimeProjection,
    buddy: BuddyProjection,
    threadId: string,
    answered: readonly BuddyMessage[],
  ): Promise<void> {
    const thread = state.threads.find((candidate) => candidate.threadId === threadId);
    if (!thread || thread.status === "working" || thread.status === "starting") return;
    if ((state.queuedMessages ?? []).some((queued) => queued.threadId === threadId)) return;
    const log = (state.messages ?? []).filter((message) => message.threadId === threadId);
    const lastAsk = log.findLastIndex((message) => message.role === "user");
    if (lastAsk === -1) return;
    // The chat may still hold the answer to an earlier message, such as one the person stopped. Only an
    // answer to one of the waiting messages counts, or a teammate would get a reply meant for someone else.
    const asked = log[lastAsk]?.text ?? "";
    if (!answered.some((message) => asked.includes(message.text.trim()))) return;
    const answer = log.slice(lastAsk + 1).findLast((message) => message.role === "assistant" && message.text.trim());
    if (!answer) {
      if (thread.status === "failed")
        await this.reply(
          buddy,
          `failed:${log[lastAsk]?.messageId}`,
          `Something went wrong: ${thread.errorMessage ?? "the agent stopped"}.`,
        );
      return;
    }
    const parsed = parseChatReply(answer.text);
    const started: string[] = [];
    for (const [index, job] of parsed.jobs.entries()) {
      const project = projectNamed(state.projects, job.project);
      const worker = (job.buddy ? buddyNamed(state, job.buddy) : undefined) ?? buddy;
      if (!project) {
        started.push(`I need to know which project: ${state.projects.map((entry) => entry.name).join(", ")}?`);
        continue;
      }
      const receipt = await this.dispatch(
        {
          type: "task.assign",
          task: {
            taskId: stableId(`buddy-chat-job:${answer.messageId}:${index}`),
            buddyId: worker.archived ? buddy.buddyId : worker.buddyId,
            projectId: project.projectId,
            kind: "job",
            goal: job.goal.slice(0, 4_000),
            origin: { kind: "buddy", threadId },
          },
        } as RuntimeCommand,
        `buddy-chat-job:${answer.messageId}:${index}`,
      );
      if (receipt.status === "rejected")
        started.push(`That job did not start: ${receipt.error?.message ?? "it was refused"}.`);
    }
    for (const [index, note] of parsed.remember.entries())
      await this.dispatch(
        {
          type: "buddy.memory.add",
          buddyId: buddy.buddyId,
          note: { noteId: stableId(`buddy-chat-note:${answer.messageId}:${index}`), text: note, source: "told" },
        } as RuntimeCommand,
        `buddy-chat-note:${answer.messageId}:${index}`,
      );
    // A teammate's message is answered once and not passed on, so two buddies never message each other in a loop.
    const fromTeammate = answered.some((message) => message.from);
    const sent: Array<{ to: string; text: string; key: string }> = [];
    if (!fromTeammate)
      for (const [index, tell] of parsed.tells.entries()) {
        const target = buddyNamed(state, tell.buddy);
        if (!target || target.archived || target.buddyId === buddy.buddyId) {
          started.push(`There is no teammate called ${tell.buddy}.`);
          continue;
        }
        const receipt = await this.dispatch(
          {
            type: "buddy.chat.send",
            buddyId: target.buddyId,
            messageId: stableId(`buddy-chat-tell:${answer.messageId}:${index}`),
            text: tell.text,
            from: buddy.buddyId,
          } as RuntimeCommand,
          `buddy-chat-tell:${answer.messageId}:${index}`,
        );
        if (receipt.status === "rejected")
          started.push(`I could not message ${target.name}: ${receipt.error?.message ?? "it was refused"}.`);
        else sent.push({ to: target.buddyId, text: tell.text, key: `tell:${answer.messageId}:${index}` });
      }
    const text = [parsed.text || (parsed.jobs.length > 0 ? "On it." : ""), ...started].filter(Boolean).join("\n\n");
    if (text) await this.reply(buddy, `answer:${answer.messageId}`, text);
    // Each message to a teammate shows in this chat as its own note, addressed to them.
    for (const note of sent) await this.reply(buddy, note.key, note.text, { to: note.to });
    if (!text) return;
    // The answer goes back to each teammate who asked, as that teammate's own words.
    for (const senderId of new Set(answered.flatMap((message) => (message.from ? [message.from] : [])))) {
      const sender = state.buddies?.find((entry) => entry.buddyId === senderId && !entry.archived);
      if (sender) await this.reply(sender, `relay:${answer.messageId}:${senderId}`, text, { from: buddy.buddyId });
    }
  }

  private reply(
    buddy: BuddyProjection,
    key: string,
    text: string,
    teammate: { from?: string; to?: string } = {},
  ): Promise<CommandReceipt> {
    return this.dispatch(
      {
        type: "buddy.chat.reply",
        buddyId: buddy.buddyId,
        messageId: stableId(`buddy-chat-reply:${key}`),
        text: text.slice(0, 20_000),
        ...teammate,
      } as RuntimeCommand,
      `buddy-chat-reply:${key}`,
    );
  }

  private dispatch(command: RuntimeCommand, key: string): Promise<CommandReceipt> {
    return this.engine.dispatchPromise({ protocolVersion: 1, commandId: CommandId.parse(stableId(key)), command });
  }
}
