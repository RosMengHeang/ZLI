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

  it("gives saved teammates their own color and everyone else their agent's, or the next free color", () => {
    const buddies = roomBuddies(
      [
        { id: "a", provider: "claude-code" },
        { id: "b", provider: "claude-code" },
        { id: "c", provider: "codex", name: "reviewer" },
        { id: "d", provider: "cursor-agent" },
      ],
      [{ id: "t", name: "Reviewer", buddy: "jade", provider: "codex" }],
    );
    // Claude Code wears tangerine, so the second one takes the first free color (sky), and the Cursor agent,
    // whose own color is sky, takes the next one.
    expect(Object.fromEntries(buddies)).toEqual({ a: "tangerine", b: "sky", c: "jade", d: "indigo" });
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
      { id: "1", name: "Reviewer", buddy: "jade", provider: "codex", permissionMode: "read-only" },
      { id: "4", name: "Tester", buddy: "tangerine", provider: "claude-code" },
    ]);
  });

  it("gives teammates saved with an animal or a body the matching color", () => {
    expect(parseTeammates([{ id: "1", name: "Owl", animal: "owl", provider: "codex" }])[0]?.buddy).toBe("paper");
    expect(parseTeammates([{ id: "1", name: "Sq", buddy: "squircle", provider: "codex" }])[0]?.buddy).toBe("paper");
  });
});
