import { describe, expect, it } from "vitest";

import {
  agentDisplay,
  deliveryNotes,
  fitHuddleName,
  heldCount,
  memberViews,
  recipientsText,
  sessionAgentId,
  sessionOfAgent,
} from "./huddles.js";
import { coder, coderId, helper, helperId, huddle, huddleProjection, posts } from "./testHuddles.js";

describe("huddle helpers", () => {
  it("adds project names to labels only when members come from several projects", () => {
    const single = huddleProjection();
    expect(memberViews(single, huddle()).get(helperId)?.display).toBe("Helper");
    const otherWorktree = "00000000-0000-4000-8000-000000000102";
    const mixed = huddleProjection({
      projects: [
        ...single.projects,
        { projectId: "00000000-0000-4000-8000-000000000011", path: "/work/api", name: "api" } as never,
      ],
      worktrees: [
        ...single.worktrees,
        {
          worktreeId: otherWorktree,
          projectId: "00000000-0000-4000-8000-000000000011",
          path: "/work/api",
          branch: "main",
          status: "ready",
        } as never,
      ],
      terminals: [{ ...coder, worktreeId: otherWorktree } as never],
    });
    const views = memberViews(mixed, huddle());
    expect(views.get(helperId)?.display).toBe("Helper (web)");
    expect(views.get(coderId)?.display).toBe("Coder (api)");
    expect(agentDisplay(mixed, views, "gone")).toBe("A removed agent");
  });

  it("writes recipients and delivery notes in words", () => {
    const name = (id: string) => (id === helperId ? "Helper" : "Coder");
    expect(recipientsText("everyone", name)).toBe("to everyone");
    expect(recipientsText("person", name)).toBe("to you");
    expect(recipientsText([helperId, coderId], name)).toBe("to Helper, Coder");
    expect(deliveryNotes(posts[2] as never, name)).toEqual(["Helper: queued. Waiting for the current turn to end."]);
    expect(deliveryNotes({ ...posts[2], deliveries: [{ agentId: coderId, status: "failed" }] } as never, name)).toEqual(
      ["Coder: not delivered."],
    );
    expect(heldCount(posts, coderId)).toBe(1);
    expect(heldCount(posts, helperId)).toBe(0);
  });

  it("finds the agent id a huddle uses for a session, and the session for an id", () => {
    const chat = {
      sessionId: "a",
      worktreeId: "w",
      provider: "codex",
      status: "ready",
      mode: "chat",
      thread: helper,
    } as const;
    const terminal = {
      sessionId: "b",
      worktreeId: "w",
      provider: "claude",
      status: "ready",
      mode: "terminal",
      terminal: coder,
    } as const;
    expect(sessionAgentId(chat)).toBe(helperId);
    expect(sessionAgentId(terminal)).toBe(coderId);
    expect(sessionAgentId({ ...terminal, terminal: { ...coder, agent: undefined } })).toBeUndefined();
    expect(sessionOfAgent([chat, terminal], coderId)?.sessionId).toBe("b");
  });

  it("keeps generated names inside the 60 character limit", () => {
    expect(fitHuddleName("Short")).toBe("Short");
    expect(fitHuddleName("x".repeat(80))).toHaveLength(60);
  });
});
