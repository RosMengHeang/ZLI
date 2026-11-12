import { describe, expect, it } from "vitest";

import { freeAgentName, leadingMentions, parseTeammates, roomAnimals } from "./teammates.js";

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

  it("gives saved teammates their own animal and everyone else their agent's, or the next free one", () => {
    const animals = roomAnimals(
      [
        { id: "a", provider: "claude-code" },
        { id: "b", provider: "claude-code" },
        { id: "c", provider: "codex", name: "reviewer" },
      ],
      [{ id: "t", name: "Reviewer", animal: "panda", provider: "codex" }],
    );
    expect(Object.fromEntries(animals)).toEqual({ a: "fox", b: "owl", c: "panda" });
  });

  it("keeps only well-formed teammates with unique names", () => {
    expect(
      parseTeammates([
        { id: "1", name: "Reviewer!", animal: "owl", provider: "codex", permissionMode: "read-only" },
        { id: "2", name: "reviewer", animal: "cat", provider: "droid" },
        { id: "3", name: "", provider: "codex" },
        { id: "4", name: "Tester", animal: "dragon", provider: "claude-code" },
      ]),
    ).toEqual([
      { id: "1", name: "Reviewer", animal: "owl", provider: "codex", permissionMode: "read-only" },
      { id: "4", name: "Tester", animal: "fox", provider: "claude-code" },
    ]);
  });
});
