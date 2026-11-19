import { describe, expect, it } from "vitest";

import { chatAfterDelete } from "./nextChat.js";

const worktrees = [
  { worktreeId: "a-main", projectId: "a" },
  { worktreeId: "a-feature", projectId: "a" },
  { worktreeId: "b-main", projectId: "b" },
];
// Project a lists its chats newest first: three, two, one.
const chats = [
  { sessionId: "one", worktreeId: "a-main", createdAt: "2026-11-01T00:00:00Z" },
  { sessionId: "two", worktreeId: "a-feature", createdAt: "2026-11-02T00:00:00Z" },
  { sessionId: "three", worktreeId: "a-main", createdAt: "2026-11-03T00:00:00Z" },
  { sessionId: "elsewhere", worktreeId: "b-main", createdAt: "2026-11-04T00:00:00Z" },
];

describe("chatAfterDelete", () => {
  it("opens the chat below the deleted one in the same project", () => {
    expect(chatAfterDelete(chats, "three", worktrees)?.sessionId).toBe("two");
    expect(chatAfterDelete(chats, "two", worktrees)?.sessionId).toBe("one");
  });

  it("opens the one above when the deleted chat was last", () => {
    expect(chatAfterDelete(chats, "one", worktrees)?.sessionId).toBe("two");
  });

  it("opens nothing when the project has no other chat, so its empty state shows", () => {
    expect(chatAfterDelete(chats, "elsewhere", worktrees)).toBeUndefined();
    expect(chatAfterDelete(chats, "missing", worktrees)).toBeUndefined();
  });
});
