// @vitest-environment jsdom

import type { BuddyMessage, BuddyProjection, RuntimeProjection } from "@zli-v2/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText as button, cleanupRuntimeRenders, renderWithRuntime, typeInto } from "../review/testRuntime.js";
import { BuddiesPane } from "./BuddiesPane.js";
import { TEAM_CHAT_ID, teamChatLines } from "./TeamChat.js";

afterEach(async () => {
  await cleanupRuntimeRenders();
});

const at = "2026-11-20T09:00:00.000Z";
const buddy = (buddyId: string, name: string, order: number, role: "primary" | "buddy" = "buddy"): BuddyProjection => ({
  buddyId,
  name,
  color: "jade",
  role,
  order,
  engine: { mode: "auto" },
  permissionMode: "full-access",
  maxActiveJobs: 2,
  handoffs: [],
  memory: [],
  pendingMemory: [],
  createdAt: at,
  updatedAt: at,
});
const team = [buddy("b1", "Pip", 0, "primary"), buddy("b2", "Builder", 1), buddy("b3", "Tester", 2)];
const message = (extra: Partial<BuddyMessage> & Pick<BuddyMessage, "messageId" | "buddyId">): BuddyMessage => ({
  role: "you",
  text: "@Builder @Tester ship it",
  at,
  ...extra,
});

function projection(buddyMessages: BuddyMessage[] = []): RuntimeProjection {
  return {
    environment: {
      environmentId: "00000000-0000-4000-8000-000000000001",
      label: "Local",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [{ projectId: "p1", path: "/work/web", name: "web" }],
    worktrees: [],
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
    buddies: team,
    buddyMessages,
  } as unknown as RuntimeProjection;
}

const accept = () => ({ result: {} });

async function render(state: RuntimeProjection, selectedId?: string) {
  const onSelect = vi.fn();
  const commands = await renderWithRuntime(
    <BuddiesPane
      projection={state}
      selectedId={selectedId}
      projectId="p1"
      onSelect={onSelect}
      onOpenThread={vi.fn()}
      onOpenPullRequest={vi.fn()}
    />,
    accept,
  );
  return { commands, onSelect };
}

describe("Team chat", () => {
  it("has an entry in the buddy list that opens it", async () => {
    const { onSelect } = await render(projection());
    const entry = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Team chat"),
    );
    expect(entry).toBeTruthy();
    await act(async () => entry?.click());
    expect(onSelect).toHaveBeenCalledWith(TEAM_CHAT_ID);
  });

  it("suggests buddies on @ and sends one team message", async () => {
    const { commands } = await render(projection(), TEAM_CHAT_ID);
    const box = document.querySelector<HTMLTextAreaElement>(".team-chat-input");
    if (!box) throw new Error("no message box");
    await typeInto(box, "@Bu");
    const options = [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent);
    expect(options).toHaveLength(1);
    expect(options[0]).toContain("Builder");
    await act(async () => (document.querySelector('[role="option"]') as HTMLElement).click());
    expect(box.value).toBe("@Builder ");
    expect(document.body.textContent).toContain("Goes to Builder");
    await act(async () => button("Send")?.click());
    expect(commands.filter((command) => command.type === "buddies.team.send")).toMatchObject([{ text: "@Builder" }]);
  });

  it("sends a message once when Send is pressed twice in a row", async () => {
    const { commands } = await render(projection(), TEAM_CHAT_ID);
    const box = document.querySelector<HTMLTextAreaElement>(".team-chat-input");
    if (!box) throw new Error("no message box");
    await typeInto(box, "hello team");
    await act(async () => {
      button("Send")?.click();
      button("Send")?.click();
    });
    expect(commands.filter((command) => command.type === "buddies.team.send")).toHaveLength(1);
    expect(box.value).toBe("");
  });

  it("shows the person's message once and each answer under its buddy", async () => {
    const state = projection([
      message({ messageId: "t1:b2", buddyId: "b2", team: "t1" }),
      message({ messageId: "t1:b3", buddyId: "b3", team: "t1" }),
      message({ messageId: "r1", buddyId: "b2", role: "buddy", text: "Built.", team: "t1" }),
      message({ messageId: "solo", buddyId: "b2", text: "just us" }),
    ]);
    const lines = teamChatLines(state);
    expect(lines.map((line) => line.kind)).toEqual(["you", "buddy"]);
    await render(state, TEAM_CHAT_ID);
    const log = document.querySelector('[aria-label="Team chat"]')?.textContent ?? "";
    expect(log).toContain("To Builder, Tester");
    expect(log).toContain("Built.");
    expect(log).not.toContain("just us");
    expect(log).toContain("Tester is answering");
  });
});
