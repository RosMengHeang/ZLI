import {
  applyBuddyEvent,
  type BuddyEvent,
  type BuddyMessage,
  EnvironmentId,
  type RuntimeCommand,
  type RuntimeProjection,
  teamTargets,
} from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { decide } from "../orchestration/decider.js";
import { teamOf } from "./BuddyChatReactor.js";

const PRIMARY = "00000000-0000-4000-8000-000000000501";
const BOB = "00000000-0000-4000-8000-000000000502";
const BOBBY = "00000000-0000-4000-8000-000000000503";
const TEAM_MESSAGE = "00000000-0000-4000-8000-000000000599";

function empty(): RuntimeProjection {
  return {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000401"),
      label: "team",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [],
    worktrees: [],
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 0,
  };
}

function run(commands: RuntimeCommand[], start = empty()): RuntimeProjection {
  let state = start;
  for (const command of commands)
    for (const event of decide(state, command))
      state = { ...state, ...applyBuddyEvent(state, event as BuddyEvent, "2026-11-20T09:00:00.000Z") };
  return state;
}

const create = (buddyId: string, name: string): RuntimeCommand => ({
  type: "buddy.create",
  buddy: {
    buddyId,
    name,
    color: "jade",
    role: "buddy",
    engine: { mode: "auto" },
    permissionMode: "full-access",
    maxActiveJobs: 2,
    handoffs: [],
  },
});

const team = () => run([create(PRIMARY, "Pip"), create(BOB, "Bob"), create(BOBBY, "Bobby")]);
const send = (text: string): RuntimeCommand => ({ type: "buddies.team.send", messageId: TEAM_MESSAGE, text });
const names = (state: RuntimeProjection, text: string) => teamTargets(state, text).map((buddy) => buddy.name);

describe("teamTargets", () => {
  it("reaches each buddy named whole, in any case", () => {
    expect(names(team(), "@bob and @BOBBY, look at this")).toEqual(["Bob", "Bobby"]);
    expect(names(team(), "@Bobby only")).toEqual(["Bobby"]);
    expect(names(team(), "ask @Bob.")).toEqual(["Bob"]);
  });

  it("does not match a name inside a longer word or an address", () => {
    expect(names(team(), "@Bo can you check?")).toEqual(["Pip"]);
    expect(names(team(), "mail bob@bobs.dev")).toEqual(["Pip"]);
  });

  it("goes to the Primary when nobody is named", () => {
    expect(names(team(), "what is everyone doing?")).toEqual(["Pip"]);
  });
});

describe("buddies.team.send", () => {
  it("lands one copy per mentioned buddy, each tagged with the team message", () => {
    const state = run([send("@Bob @Bobby run the tests")], team());
    const copies = state.buddyMessages ?? [];
    expect(copies.map((message) => message.buddyId)).toEqual([BOB, BOBBY]);
    expect(copies.every((message) => message.team === TEAM_MESSAGE && message.role === "you")).toBe(true);
  });

  it("lands once however often it is sent", () => {
    const state = run([send("@Bob hi"), send("@Bob hi")], team());
    expect(state.buddyMessages).toHaveLength(1);
  });

  it("skips a removed buddy and falls back to the Primary", () => {
    const state = run([{ type: "buddy.archive", buddyId: BOB }, send("@Bob hi")], team());
    expect((state.buddyMessages ?? []).map((message) => message.buddyId)).toEqual([PRIMARY]);
  });
});

describe("teamOf", () => {
  const message = (extra: Partial<BuddyMessage>): BuddyMessage => ({
    messageId: "m",
    buddyId: BOB,
    role: "you",
    text: "hi",
    at: "2026-11-20T09:00:00.000Z",
    ...extra,
  });

  it("tags a reply with the team message it answers", () => {
    expect(teamOf([message({ team: TEAM_MESSAGE })])).toEqual({ team: TEAM_MESSAGE });
  });

  it("leaves a 1:1 reply untagged", () => {
    expect(teamOf([message({})])).toEqual({});
  });
});
