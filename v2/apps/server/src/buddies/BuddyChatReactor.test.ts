import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommandId,
  type EnvironmentDescriptor,
  EnvironmentId,
  type ProviderDiscovery,
  type RuntimeCommand,
  type RuntimeProjection,
} from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
import { BuddyChatReactor } from "./BuddyChatReactor.js";
import { parseChatReply } from "./chat.js";
import { stableId } from "./TaskReactor.js";

const environment: EnvironmentDescriptor = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000002"),
  label: "Buddy chat",
  protocolVersion: 1,
  capabilities: {},
};
const providers: ProviderDiscovery[] = [
  {
    provider: "claude-code",
    displayName: "Claude Code",
    status: "found",
    path: "claude",
    models: [{ id: "claude-sonnet-5-5", label: "Sonnet" }],
  },
];

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

let counter = 0;
function send(engine: Engine, command: RuntimeCommand) {
  counter += 1;
  return engine.dispatchPromise({
    protocolVersion: 1,
    commandId: CommandId.parse(stableId(`chat-test:${counter}`)),
    command,
  });
}

async function setup() {
  const database = new Database({ path: ":memory:" });
  const engine = new Engine({ database, environment });
  const reactor = new BuddyChatReactor(engine, { providers: async () => providers });
  const folder = mkdtempSync(join(tmpdir(), "zli-buddy-chat-"));
  cleanup.push(
    () => rmSync(folder, { recursive: true, force: true }),
    () => database.close(),
    () => reactor.stop(),
  );
  const registered = await send(engine, { type: "project.register", path: folder } as RuntimeCommand);
  const projectId = registered.result?.projectId as string;
  await send(engine, {
    type: "buddy.create",
    buddy: {
      buddyId: "b1",
      name: "Builder",
      color: "sky",
      role: "buddy",
      engine: { mode: "auto" },
      permissionMode: "full-access",
      maxActiveJobs: 2,
      handoffs: [],
    },
  } as RuntimeCommand);
  const settle = async (): Promise<RuntimeProjection> => {
    for (let round = 0; round < 5; round += 1) await reactor.waitForIdle();
    return engine.projection();
  };
  /** What the agent would do: take the queued message, answer, and go idle. */
  const answer = async (text: string, buddyId = "b1") => {
    let state = await settle();
    const threadId = state.buddies?.find((entry) => entry.buddyId === buddyId)?.chatThreadId as string;
    for (const queued of state.queuedMessages ?? [])
      if (queued.threadId === threadId) {
        await send(engine, { type: "thread.queue.remove", threadId, queueId: queued.queueId } as RuntimeCommand);
        await send(engine, {
          type: "thread.message",
          message: { messageId: `u-${queued.queueId}`, threadId, role: "user", text: queued.text },
        } as RuntimeCommand);
      }
    await send(engine, {
      type: "thread.message",
      message: { messageId: `a-${counter}`, threadId, role: "assistant", text },
    } as RuntimeCommand);
    await send(engine, { type: "thread.status", threadId, status: "idle" } as RuntimeCommand);
    state = await settle();
    return state;
  };
  return { engine, projectId, settle, answer };
}

describe("parseChatReply", () => {
  it("reads jobs and notes out of a reply and leaves the words", () => {
    const reply = parseChatReply(
      'Sure, I\'ll fix it.\n\n[[job project="shop-web"]]\nFix the cart total when a coupon is applied twice.\n[[/job]]\n[[remember]]Prefers small PRs.[[/remember]]',
    );
    expect(reply).toEqual({
      text: "Sure, I'll fix it.",
      jobs: [{ project: "shop-web", goal: "Fix the cart total when a coupon is applied twice." }],
      remember: ["Prefers small PRs."],
      tells: [],
    });
  });

  it("starts nothing from the brief's own placeholders", () => {
    expect(parseChatReply("[[job]]\n<the job>\n[[/job]][[remember]]<one short sentence>[[/remember]]")).toEqual({
      text: "",
      jobs: [],
      remember: [],
      tells: [],
    });
  });
});

describe("BuddyChatReactor", () => {
  it("answers a greeting in a hidden read-only chat and starts no job", async () => {
    const { engine, settle, answer } = await setup();
    await send(engine, { type: "buddy.chat.send", buddyId: "b1", messageId: "msg-1", text: "hello" } as RuntimeCommand);
    const started = await settle();
    const thread = started.threads.find((candidate) => candidate.threadId === started.buddies?.[0]?.chatThreadId);
    expect(thread?.permissionMode).toBe("read-only");
    expect(thread?.unattended).toBe(true);
    expect(started.queuedMessages?.[0]?.text).toBe("hello");

    const state = await answer("Hi! What are we working on today?");
    expect(state.buddyMessages?.map((message) => [message.role, message.text])).toEqual([
      ["you", "hello"],
      ["buddy", "Hi! What are we working on today?"],
    ]);
    expect(state.tasks ?? []).toEqual([]);
  });

  it("starts the job a reply asks for, and keeps what it was told", async () => {
    const { engine, projectId, settle, answer } = await setup();
    await send(engine, {
      type: "buddy.chat.send",
      buddyId: "b1",
      messageId: "msg-2",
      text: "Add a dark mode toggle. I like small PRs.",
    } as RuntimeCommand);
    await settle();
    const state = await answer(
      "Starting on it.\n[[job]]\nAdd a dark mode toggle to settings.\n[[/job]]\n[[remember]]Likes small PRs.[[/remember]]",
    );
    expect(state.tasks?.map((task) => [task.buddyId, task.projectId, task.goal, task.origin.kind])).toEqual([
      ["b1", projectId, "Add a dark mode toggle to settings.", "buddy"],
    ]);
    expect(state.buddies?.[0]?.memory.map((note) => note.text)).toEqual(["Likes small PRs."]);
    expect(state.buddyMessages?.at(-1)?.text).toBe("Starting on it.");
  });

  it("delivers a message to a teammate and brings the answer back, without a loop", async () => {
    const { engine, settle, answer } = await setup();
    await send(engine, {
      type: "buddy.create",
      buddy: {
        buddyId: "b2",
        name: "Primary",
        color: "indigo",
        role: "primary",
        engine: { mode: "auto" },
        permissionMode: "read-only",
        maxActiveJobs: 1,
        handoffs: [],
      },
    } as RuntimeCommand);
    await send(engine, {
      type: "buddy.chat.send",
      buddyId: "b1",
      messageId: "msg-3",
      text: "Ask Primary how its day was",
    } as RuntimeCommand);
    await settle();
    let state = await answer('Asking now.\n[[tell buddy="Primary"]]How was your day?[[/tell]]');
    const chat = (buddyId: string) =>
      state.buddyMessages
        ?.filter((message) => message.buddyId === buddyId)
        .map((message) => [message.role, message.from ?? "", message.text]);
    expect(chat("b1")?.at(-1)).toEqual(["buddy", "", 'Asking now.\n\nSent Primary: "How was your day?"']);
    expect(chat("b2")).toEqual([["you", "b1", "How was your day?"]]);
    const primaryThread = state.buddies?.find((entry) => entry.buddyId === "b2")?.chatThreadId;
    expect(state.queuedMessages?.find((queued) => queued.threadId === primaryThread)?.text).toContain(
      "Builder, your teammate, says:\nHow was your day?",
    );

    // Primary answers and tries to message back: the answer goes to Builder, the message does not.
    state = await answer('Great, thanks!\n[[tell buddy="Builder"]]And yours?[[/tell]]', "b2");
    expect(chat("b2")?.at(-1)).toEqual(["buddy", "", "Great, thanks!"]);
    expect(chat("b1")?.at(-1)).toEqual(["buddy", "", "Primary replied: Great, thanks!"]);
    expect(chat("b1")?.filter(([role]) => role === "you")).toHaveLength(1);
  });

  it("replaces a chat started before chats ran unattended, which may be stuck on a prompt", async () => {
    const { engine, settle } = await setup();
    await send(engine, { type: "buddy.chat.send", buddyId: "b1", messageId: "msg-5", text: "hello" } as RuntimeCommand);
    const first = await settle();
    const old = first.threads.find((candidate) => candidate.threadId === first.buddies?.[0]?.chatThreadId);
    if (!old) throw new Error("No chat thread");
    const legacy = stableId("legacy-chat");
    await send(engine, {
      type: "thread.start",
      threadId: legacy,
      worktreeId: old.worktreeId,
      provider: "claude-code",
      cwd: "unused",
      permissionMode: "read-only",
      shareWorktree: true,
    } as RuntimeCommand);
    await send(engine, { type: "buddy.chat.thread", buddyId: "b1", threadId: legacy } as RuntimeCommand);
    await send(engine, {
      type: "buddy.chat.send",
      buddyId: "b1",
      messageId: "msg-6",
      text: "still there?",
    } as RuntimeCommand);
    const state = await settle();
    const stops = (await engine.eventsAfter(0)).filter(
      (envelope) => envelope.event.type === "thread.stop.requested" && envelope.event.threadId === legacy,
    );
    expect(stops).toHaveLength(1);
    const current = state.threads.find((candidate) => candidate.threadId === state.buddies?.[0]?.chatThreadId);
    expect(current?.threadId).not.toBe(legacy);
    expect(current?.unattended).toBe(true);
  });

  it("does not let a buddy send itself a teammate's message", async () => {
    const { engine } = await setup();
    const receipt = await send(engine, {
      type: "buddy.chat.send",
      buddyId: "b1",
      messageId: "msg-4",
      text: "Hi me",
      from: "b1",
    } as RuntimeCommand);
    expect(receipt.status).toBe("rejected");
  });
});
