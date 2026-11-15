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
  const answer = async (text: string) => {
    let state = await settle();
    const threadId = state.buddies?.[0]?.chatThreadId as string;
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
    });
  });

  it("starts nothing from the brief's own placeholders", () => {
    expect(parseChatReply("[[job]]\n<the job>\n[[/job]][[remember]]<one short sentence>[[/remember]]")).toEqual({
      text: "",
      jobs: [],
      remember: [],
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
});
