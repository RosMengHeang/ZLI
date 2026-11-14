import { describe, expect, it } from "vitest";

import { freeAgentName, leadingMentions, parseTeammates, roomBuddies } from "./teammates.js";

describe("teammates", () => {
  it("reads the names a message opens with, longest name first, and leaves the rest", () => {
    const names = ["Owl", "Code Reviewer", "Code"];
    expect(leadingMentions("@Owl @code reviewer: check this", names)).toEqual({
      names: ["Owl", "Code Reviewer"],
      rest: "check this",
    });
    expect(leadingMentions("@Owlet hi", names).names).toEqual([]);
    expect(leadingMentions("hi @Owl", names).names).toEqual([]);
  });

  it("numbers a name the project already uses", () => {
    expect(freeAgentName("Owl", ["owl", "Owl 2", undefined])).toBe("Owl 3");
    expect(freeAgentName("Fox", ["Owl"])).toBe("Fox");
  });

  it("gives saved teammates their own buddy and everyone else their agent's, or the next free body", () => {
    const buddies = roomBuddies(
      [
        { id: "a", provider: "claude-code" },
        { id: "b", provider: "claude-code" },
        { id: "c", provider: "codex", name: "reviewer" },
        { id: "d", provider: "cursor-agent" },
      ],
      [{ id: "t", name: "Reviewer", buddy: "cloud/jade", provider: "codex" }],
    );
    // The saved Reviewer is a jade Cloud, so the Cursor agent's own Cloud is taken by body, not by color.
    expect(Object.fromEntries(buddies)).toEqual({ a: "gumdrop", b: "capsule", c: "cloud/jade", d: "plus" });
  });

  it("keeps only well-formed teammates with unique names", () => {
    expect(
      parseTeammates([
        { id: "1", name: "Reviewer!", buddy: "cloud/jade", provider: "codex", permissionMode: "read-only" },
        { id: "2", name: "reviewer", buddy: "cloud", provider: "droid" },
        { id: "3", name: "", provider: "codex" },
        { id: "4", name: "Tester", animal: "dragon", provider: "claude-code" },
      ]),
    ).toEqual([
      { id: "1", name: "Reviewer", buddy: "cloud/jade", provider: "codex", permissionMode: "read-only" },
      { id: "4", name: "Tester", buddy: "gumdrop", provider: "claude-code" },
    ]);
  });

  it("gives teammates saved with an animal the matching buddy", () => {
    expect(parseTeammates([{ id: "1", name: "Owl", animal: "owl", provider: "codex" }])[0]?.buddy).toBe("squircle");
  });
});
