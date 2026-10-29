import { randomUUID } from "node:crypto";

import {
  type AgentToolScope,
  CommandId,
  EnvironmentId,
  HUDDLE_AGENT_STREAK_LIMIT,
  HUDDLE_PAUSED_REASON,
  HuddleId,
  HuddlePostId,
  ProjectId,
  type RuntimeCommand,
  type RuntimeProjection,
  TerminalId,
  ThreadId,
  WorktreeId,
} from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { Database } from "../db/Database.js";
import { DomainError, decide } from "../orchestration/decider.js";
import { Engine } from "../orchestration/Engine.js";
import { HUDDLE_SCOPE_REASON, HuddleReactor } from "./HuddleReactor.js";
import { huddleScopeError } from "./huddleScope.js";
import { TerminalInputTracker } from "./TerminalInputTracker.js";

const environment = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000901"),
  label: "Huddles",
  protocolVersion: 1 as const,
  capabilities: {},
};
const projectA = ProjectId.parse("00000000-0000-4000-8000-000000000911");
const projectB = ProjectId.parse("00000000-0000-4000-8000-000000000912");
const worktreeA = WorktreeId.parse("00000000-0000-4000-8000-000000000921");
const worktreeB = WorktreeId.parse("00000000-0000-4000-8000-000000000922");
const lead = ThreadId.parse("00000000-0000-4000-8000-000000000931");
const helper = ThreadId.parse("00000000-0000-4000-8000-000000000932");
const remote = ThreadId.parse("00000000-0000-4000-8000-000000000933");
const coder = TerminalId.parse("00000000-0000-4000-8000-000000000941");
const shell = TerminalId.parse("00000000-0000-4000-8000-000000000942");
const huddleId = HuddleId.parse("00000000-0000-4000-8000-000000000951");

function seed(): RuntimeProjection {
  return {
    environment,
    projects: [
      { projectId: projectA, path: "/work/api", name: "api" },
      { projectId: projectB, path: "/work/web", name: "web" },
    ],
    worktrees: [
      { worktreeId: worktreeA, projectId: projectA, path: "/work/api", branch: "main", status: "ready" },
      { worktreeId: worktreeB, projectId: projectB, path: "/work/web", branch: "main", status: "ready" },
    ],
    threads: [
      { threadId: lead, worktreeId: worktreeA, provider: "codex", status: "idle", capabilities: {}, name: "Lead" },
      {
        threadId: helper,
        worktreeId: worktreeA,
        provider: "claude-code",
        status: "idle",
        capabilities: {},
        name: "Helper",
      },
      { threadId: remote, worktreeId: worktreeB, provider: "codex", status: "idle", capabilities: {}, name: "Remote" },
    ],
    terminals: [
      {
        terminalId: coder,
        worktreeId: worktreeA,
        title: "Claude Code",
        status: "running",
        lastSequence: 0,
        kind: "agent",
        agent: { provider: "claude-code" },
        name: "Coder",
      },
      { terminalId: shell, worktreeId: worktreeA, title: "bash", status: "running", lastSequence: 0, kind: "shell" },
    ],
    browserTabs: [],
    attention: [],
    lastSequence: 0,
  };
}

const databases: Database[] = [];
const reactors: HuddleReactor[] = [];

afterEach(() => {
  for (const reactor of reactors.splice(0)) reactor.stop();
  for (const database of databases.splice(0)) database.close();
});

function harness(state: RuntimeProjection = seed()) {
  const database = new Database({ path: ":memory:" });
  databases.push(database);
  database.execute("INSERT INTO projection_state (projection_id, revision, projection_json) VALUES (1, 0, ?)", [
    JSON.stringify(state),
  ]);
  const engine = new Engine({ database, environment });
  let input = new TerminalInputTracker();
  const typed: Array<{ terminalId: string; data: string }> = [];
  let scope: AgentToolScope = "all";
  const startReactor = () => {
    const started = new HuddleReactor(engine, {
      input,
      writeTerminal: (terminalId, data) => typed.push({ terminalId, data }),
      agentScope: () => scope,
      sleep: () => Promise.resolve(),
    });
    reactors.push(started);
    return started;
  };
  let reactor = startReactor();
  /** Stops ZLI's reactor, as quitting does: what it held in memory is gone. */
  const stop = () => reactor.stop();
  /** Starts a fresh reactor on the same event log, as opening ZLI again does. */
  const restart = () => {
    reactor.stop();
    input = new TerminalInputTracker();
    reactor = startReactor();
  };
  const setScope = (next: AgentToolScope) => {
    scope = next;
    reactor.refresh();
  };
  const run = async (command: Record<string, unknown>) => {
    const receipt = await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse(randomUUID()),
      command: command as RuntimeCommand,
    });
    await reactor.waitForIdle();
    return receipt;
  };
  const settle = async () => {
    await reactor.waitForIdle();
    await engine.waitForReactors();
  };
  const sends = async (threadId: string) =>
    (await engine.eventsAfter(0)).flatMap((envelope) =>
      envelope.event.type === "thread.send.requested" && envelope.event.threadId === threadId
        ? [envelope.event.text]
        : [],
    );
  /** Plays a provider turn: the message as the user line, the answer, then idle. */
  const answer = async (threadId: string, text: string, reply: string) => {
    await run({ type: "thread.message", message: { messageId: randomUUID(), threadId, role: "user", text } });
    await run({
      type: "thread.message",
      message: { messageId: randomUUID(), threadId, role: "assistant", text: reply, turnId: "turn-1" },
    });
    await run({ type: "thread.status", threadId, status: "idle" });
  };
  const post = (fields: Record<string, unknown>) =>
    run({ type: "huddle.post", huddleId, postId: randomUUID(), to: "everyone", kind: "ask", ...fields });
  return { engine, input, typed, run, settle, sends, answer, post, stop, restart, setScope };
}

function postCommand(fields: Record<string, unknown>): RuntimeCommand {
  return {
    type: "huddle.post",
    huddleId,
    postId: HuddlePostId.parse(randomUUID()),
    to: "everyone",
    kind: "ask",
    text: "Plan the migration.",
    ...fields,
  } as RuntimeCommand;
}

function withHuddle(members: string[]): RuntimeProjection {
  const state = seed();
  return {
    ...state,
    huddles: [
      {
        huddleId,
        name: "Migration",
        members: members.map((agentId) => ({
          agentId,
          kind: agentId === coder ? ("terminal" as const) : ("chat" as const),
          joinedAt: "2026-01-01T00:00:00.000Z",
        })),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        agentStreak: 0,
        nextNumber: 1,
      },
    ],
    huddlePosts: [],
  };
}

describe("huddle decisions", () => {
  it("lets only agents join, never a plain shell", () => {
    const state = withHuddle([]);
    expect(decide(state, { type: "huddle.join", huddleId, agentId: coder })).toEqual([
      { type: "huddle.member.joined", huddleId, member: { agentId: coder, kind: "terminal" } },
    ]);
    expect(() => decide(state, { type: "huddle.join", huddleId, agentId: shell })).toThrowError(
      "Only agents can join a huddle. This terminal runs a plain shell.",
    );
  });

  it("takes posts only from members, and delivers to everyone but the sender", () => {
    const state = withHuddle([lead, helper]);
    expect(() => decide(state, postCommand({ from: remote }))).toThrowError(
      "Only members of the huddle can post there.",
    );
    expect(() => decide(state, postCommand({ to: [remote] }))).toThrowError("Not in this huddle: Remote.");
    const [posted] = decide(state, postCommand({ from: lead }));
    expect(posted).toMatchObject({
      type: "huddle.posted",
      post: { number: 1, from: { kind: "agent", agentId: lead }, deliveries: [{ agentId: helper, status: "pending" }] },
    });
  });

  it("refuses posts to an archived huddle", () => {
    const state = withHuddle([lead, helper]);
    const archived = { ...state, huddles: state.huddles?.map((huddle) => ({ ...huddle, archived: true as const })) };
    expect(() => decide(archived, postCommand({}))).toThrow(DomainError);
  });

  it("holds agent messages past the streak limit until the person writes", () => {
    const state = withHuddle([lead, helper]);
    const streaked = {
      ...state,
      huddles: state.huddles?.map((huddle) => ({ ...huddle, agentStreak: HUDDLE_AGENT_STREAK_LIMIT })),
    };
    const [held] = decide(streaked, postCommand({ from: lead, kind: "note" }));
    expect(held).toMatchObject({
      post: { deliveries: [{ agentId: helper, status: "held", reason: HUDDLE_PAUSED_REASON }] },
    });
    const [fromPerson] = decide(streaked, postCommand({}));
    expect(fromPerson).toMatchObject({ post: { deliveries: [{ status: "pending" }, { status: "pending" }] } });
  });

  it("needs the every-project setting for a huddle across projects", () => {
    const state = withHuddle([lead]);
    const join = { type: "huddle.join", huddleId, agentId: remote } as RuntimeCommand;
    expect(huddleScopeError(state, join, "project")).toMatch(/more than one project/u);
    expect(huddleScopeError(state, join, "all")).toBeUndefined();
    expect(huddleScopeError(state, { type: "huddle.join", huddleId, agentId: helper }, "project")).toBeUndefined();
  });
});

describe("HuddleReactor", () => {
  it("delivers to chats, posts a chat's answer back, and introduces each member once", async () => {
    const { engine, run, post, settle, sends, answer } = harness();
    await run({ type: "huddle.create", huddleId, name: "Migration", members: [lead, helper] });
    await post({ text: "Which tables move first?" });
    await settle();

    const [toHelper] = await sends(helper);
    expect(toHelper).toContain('Huddle "Migration", message 1: The person running ZLI asks everyone:');
    expect(toHelper).toContain("Members: Lead (chat), Helper (you).");
    await answer(helper, toHelper as string, "Users first, then orders.");
    await settle();

    const posts = (await engine.projection()).huddlePosts ?? [];
    expect(posts.map((entry) => entry.text)).toEqual(["Which tables move first?", "Users first, then orders."]);
    expect(posts[1]).toMatchObject({
      from: { kind: "agent", agentId: helper },
      to: "person",
      kind: "note",
      auto: true,
    });
    expect(posts[0]?.deliveries.find((delivery) => delivery.agentId === helper)).toEqual({
      agentId: helper,
      status: "delivered",
      sentHash: expect.stringMatching(/^[0-9a-f]{16}$/u),
    });

    const [toLead] = await sends(lead);
    await answer(lead, toLead as string, "Agreed.");
    await post({ text: "Lead, ship it?", to: [lead] });
    await settle();
    const later = await sends(lead);
    expect(later).toHaveLength(2);
    expect(later[1]).toContain("The person running ZLI asks you:");
    expect(later[1]).not.toContain("Members:");
  });

  it("queues for a busy chat and confirms delivery once the chat sends it", async () => {
    const state = seed();
    state.threads = state.threads.map((thread) =>
      thread.threadId === helper ? { ...thread, status: "working" } : thread,
    );
    const { engine, run, post, settle } = harness(state);
    await run({ type: "huddle.create", huddleId, name: "Migration", members: [lead, helper] });
    await post({ from: lead, to: [helper], text: "Check the indexes." });
    await settle();
    const status = async () => (await engine.projection()).huddlePosts?.[0]?.deliveries[0]?.status;
    expect(await status()).toBe("queued");

    await run({ type: "thread.status", threadId: helper, status: "idle" });
    await run({ type: "thread.queue.flush", threadId: helper });
    await settle();
    expect(await status()).toBe("delivered");
  });

  it("does not post an answer when the agent already posted in the huddle that turn", async () => {
    const { engine, run, post, settle, sends, answer } = harness();
    await run({ type: "huddle.create", huddleId, name: "Migration", members: [lead, helper] });
    await post({ to: [helper], text: "Status?" });
    await settle();
    await post({ from: helper, to: "person", kind: "note", text: "Halfway." });
    const [sent] = await sends(helper);
    await answer(helper, sent as string, "Done with the plan.");
    await settle();
    expect(((await engine.projection()).huddlePosts ?? []).map((entry) => entry.text)).toEqual(["Status?", "Halfway."]);
  });

  it("holds a terminal message while the person has unsent typing there", async () => {
    const { engine, input, typed, run, post, settle } = harness();
    await run({ type: "huddle.create", huddleId, name: "Migration", members: [lead, coder] });
    input.record(coder, "git sta");
    await post({ from: lead, to: [coder], kind: "assign", text: "Run the migration tests." });
    await settle();
    const delivery = async () => (await engine.projection()).huddlePosts?.[0]?.deliveries[0];
    expect(await delivery()).toMatchObject({
      status: "held",
      reason: "Held while you have unsent typing in this terminal.",
    });
    expect(typed).toEqual([]);

    input.record(coder, "\r");
    await settle();
    expect(await delivery()).toMatchObject({ status: "delivered" });
    expect(typed[0]?.data.startsWith('\u001b[200~Huddle "Migration", message 1: Lead gives you this task:')).toBe(true);
    expect(typed[0]?.data).toContain('zli huddle post --huddle 00000000 "your answer"');
    expect(typed[1]).toEqual({ terminalId: coder, data: "\r" });
  });

  it("types held messages when the person releases them", async () => {
    const { engine, input, typed, run, post, settle } = harness();
    await run({ type: "huddle.create", huddleId, name: "Migration", members: [lead, coder] });
    input.record(coder, "draft");
    await post({ from: lead, to: [coder], kind: "note", text: "FYI the schema changed." });
    await settle();
    await run({ type: "huddle.release", agentId: coder });
    await settle();
    expect((await engine.projection()).huddlePosts?.[0]?.deliveries[0]?.status).toBe("delivered");
    expect(typed).toHaveLength(2);
  });

  it("pauses after the agent streak limit and resumes on request", async () => {
    const { engine, run, post, settle } = harness();
    await run({ type: "huddle.create", huddleId, name: "Migration", members: [lead, coder] });
    for (let index = 0; index <= HUDDLE_AGENT_STREAK_LIMIT; index += 1)
      await post({ from: lead, to: [coder], kind: "note", text: `Update ${index + 1}` });
    await settle();
    let state = await engine.projection();
    expect(state.huddles?.[0]?.paused).toBe(true);
    expect(state.huddlePosts?.at(-1)?.deliveries[0]).toMatchObject({ status: "held", reason: HUDDLE_PAUSED_REASON });

    await run({ type: "huddle.resume", huddleId });
    await settle();
    state = await engine.projection();
    expect(state.huddles?.[0]?.paused).toBeUndefined();
    expect(state.huddlePosts?.at(-1)?.deliveries[0]?.status).toBe("delivered");
  });

  it("fails open deliveries for a member that leaves", async () => {
    const state = seed();
    state.terminals = state.terminals.map((terminal) =>
      terminal.terminalId === coder ? { ...terminal, status: "starting" } : terminal,
    );
    const { engine, run, post, settle } = harness(state);
    await run({ type: "huddle.create", huddleId, name: "Migration", members: [lead, coder] });
    await post({ from: lead, to: [coder], text: "Ready?" });
    await settle();
    expect((await engine.projection()).huddlePosts?.[0]?.deliveries[0]?.status).toBe("held");
    await run({ type: "huddle.leave", huddleId, agentId: coder });
    expect((await engine.projection()).huddlePosts?.[0]?.deliveries[0]).toEqual({
      agentId: coder,
      status: "failed",
      reason: "Left the huddle before this went out.",
    });
  });

  it("neither sends a chat message twice nor loses its answer when ZLI stops before recording the send", async () => {
    const { engine, run, post, settle, sends, answer, stop, restart } = harness();
    await run({ type: "huddle.create", huddleId, name: "Migration", members: [lead, helper] });
    await post({ to: [helper], text: "Which tables move first?" });
    await settle();
    const [sent] = await sends(helper);
    const postId = (await engine.projection()).huddlePosts?.[0]?.postId;
    stop();
    // The old process handed the message over but quit before marking it delivered.
    await run({ type: "huddle.delivery", huddleId, postId, agentId: helper, status: "pending" });
    await answer(helper, sent as string, "Users first.");
    restart();
    await settle();

    expect(await sends(helper)).toHaveLength(1);
    const posts = (await engine.projection()).huddlePosts ?? [];
    expect(posts.map((entry) => entry.text)).toEqual(["Which tables move first?", "Users first."]);
    expect(posts[0]?.deliveries[0]).toMatchObject({ status: "delivered" });
    expect(posts[0]?.deliveries[0]?.awaitingReply).toBeUndefined();
  });

  it("does not type into a terminal again when ZLI stopped while typing", async () => {
    const { engine, input, typed, run, post, settle, stop, restart } = harness();
    await run({ type: "huddle.create", huddleId, name: "Migration", members: [lead, coder] });
    input.record(coder, "draft");
    await post({ from: lead, to: [coder], kind: "assign", text: "Run the migration tests." });
    await settle();
    const postId = (await engine.projection()).huddlePosts?.[0]?.postId;
    stop();
    // The old process recorded what it was about to type, then quit partway through.
    await run({
      type: "huddle.delivery",
      huddleId,
      postId,
      agentId: coder,
      status: "pending",
      sentHash: "0123456789abcdef",
    });
    restart();
    await settle();

    expect(typed).toEqual([]);
    expect((await engine.projection()).huddlePosts?.[0]?.deliveries[0]).toMatchObject({
      status: "delivered",
      reason: expect.stringContaining("not typed again"),
    });
  });

  it("holds a huddle across projects while Settings keep agents to their own project", async () => {
    const state = seed();
    state.threads = state.threads.map((thread) =>
      thread.threadId === helper ? { ...thread, status: "working" } : thread,
    );
    const { engine, run, post, settle, sends, setScope } = harness(state);
    await run({ type: "huddle.create", huddleId, name: "Migration", members: [lead, helper, remote] });
    await post({ text: "Which tables move first?" });
    await settle();
    const deliveries = async () => (await engine.projection()).huddlePosts?.[0]?.deliveries ?? [];
    expect((await deliveries()).map((delivery) => delivery.status)).toEqual(["delivered", "queued", "delivered"]);

    setScope("project");
    await post({ text: "And the indexes?" });
    await settle();
    const projection = await engine.projection();
    expect(projection.huddlePosts?.[1]?.deliveries.map((delivery) => delivery.reason)).toEqual([
      HUDDLE_SCOPE_REASON,
      HUDDLE_SCOPE_REASON,
      HUDDLE_SCOPE_REASON,
    ]);
    // The queued message had not gone out, so it comes back out of the chat's queue.
    expect(projection.queuedMessages ?? []).toEqual([]);
    expect((await deliveries())[1]).toMatchObject({ status: "held", reason: HUDDLE_SCOPE_REASON });
    expect(await sends(remote)).toHaveLength(1);

    setScope("all");
    await settle();
    // Each chat is still busy with the first message, so the second waits in its queue.
    const resumed = await engine.projection();
    expect(resumed.huddlePosts?.[1]?.deliveries.map((delivery) => delivery.status)).toEqual([
      "queued",
      "queued",
      "queued",
    ]);
    expect(resumed.queuedMessages ?? []).toHaveLength(4);
  });
});

describe("TerminalInputTracker", () => {
  it("counts typed characters until Enter, and ignores arrow keys", () => {
    const tracker = new TerminalInputTracker();
    const changes: string[] = [];
    tracker.onChange((terminalId) => changes.push(terminalId));
    tracker.record("t", "\u001b[A");
    expect(tracker.hasUnsent("t")).toBe(false);
    tracker.record("t", "ab");
    expect(tracker.hasUnsent("t")).toBe(true);
    tracker.record("t", "\u007f\u007f");
    expect(tracker.hasUnsent("t")).toBe(false);
    tracker.record("t", "x\u0003");
    expect(tracker.hasUnsent("t")).toBe(false);
    tracker.record("t", "ls\r");
    expect(changes).toEqual(["t", "t"]);
  });
});
