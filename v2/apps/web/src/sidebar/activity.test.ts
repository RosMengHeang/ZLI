import { describe, expect, it } from "vitest";

import { activityGroups } from "./activity.js";

describe("activityGroups", () => {
  it("groups chats by when they last moved, newest first, with pinned and busy chats on top", () => {
    const now = new Date(2026, 10, 17, 15, 0);
    const at = (days: number, hours = 0) => new Date(2026, 10, 17 - days, 15 - hours, 0).toISOString();
    const chats = [
      { sessionId: "old", status: "ready", updatedAt: at(20) },
      { sessionId: "busy", status: "working", updatedAt: at(3) },
      { sessionId: "today", status: "ready", updatedAt: at(0, 5) },
      { sessionId: "just", status: "ready", updatedAt: new Date(2026, 10, 17, 14, 40).toISOString() },
      { sessionId: "yesterday", status: "ready", updatedAt: at(1) },
      { sessionId: "week", status: "failed", updatedAt: at(4) },
      { sessionId: "pinned", status: "ready", updatedAt: at(30) },
    ];
    const groups = activityGroups(chats, now, (id) => id === "pinned");
    expect(groups.map((group) => [group.label, group.chats.map((chat) => chat.sessionId)])).toEqual([
      ["Pinned", ["pinned"]],
      ["Recent", ["just", "busy"]],
      ["Today", ["today"]],
      ["Yesterday", ["yesterday"]],
      ["Previous 7 days", ["week"]],
      ["Earlier", ["old"]],
    ]);
    expect(activityGroups([], now, () => false)).toEqual([]);
  });
});
