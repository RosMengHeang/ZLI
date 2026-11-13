// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

describe("chat buddies", () => {
  it("reads chats saved with an animal as the matching buddy, and gives new chats unused bodies", async () => {
    window.localStorage.setItem("zli.chat.animals", JSON.stringify({ old: "cat", broken: "dragon" }));
    const { assignChatBuddies, storedChatBuddy } = await import("./chatBuddies.js");
    expect(storedChatBuddy("old")).toBe("cloud");
    expect(storedChatBuddy("broken")).toBeUndefined();
    assignChatBuddies(["old", "new"]);
    const fresh = storedChatBuddy("new");
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe("cloud");
  });
});
