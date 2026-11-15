// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BUDDY_COLOR_NAMES } from "./buddies.js";

beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

describe("chat buddies", () => {
  it("reads chats saved with an animal or a body as the matching color", async () => {
    window.localStorage.setItem(
      "zli.chat.animals",
      JSON.stringify({ cat: "cat", jade: "cloud/jade", paper: "squircle", broken: "dragon" }),
    );
    const { storedChatBuddy } = await import("./chatBuddies.js");
    expect(storedChatBuddy("cat")).toBe("sky");
    expect(storedChatBuddy("jade")).toBe("jade");
    expect(storedChatBuddy("paper")).toBe("paper");
    expect(storedChatBuddy("broken")).toBeUndefined();
  });

  it("survives broken storage", async () => {
    window.localStorage.setItem("zli.chat.animals", "{not json");
    const { hashedBuddy, storedChatBuddy } = await import("./chatBuddies.js");
    expect(storedChatBuddy("c1")).toBeUndefined();
    expect(BUDDY_COLOR_NAMES).toContain(hashedBuddy("c1"));
  });

  it("gives 12 new chats 12 different colors", async () => {
    const { assignChatBuddies, storedChatBuddy } = await import("./chatBuddies.js");
    const ids = Array.from({ length: 12 }, (_, index) => `chat-${index}`);
    assignChatBuddies(ids);
    expect(new Set(ids.map((id) => storedChatBuddy(id))).size).toBe(12);
  });
});
