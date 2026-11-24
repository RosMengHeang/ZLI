import { describe, expect, it } from "vitest";
import { replacedIndexes, replaceNote } from "./replaced.js";

const message = (messageId: string, role: string) => ({ kind: "message" as const, message: { messageId, role } });
const work = { kind: "work" as const };

describe("replacedIndexes", () => {
  const timeline = [
    message("u1", "user"),
    message("a1", "assistant"),
    message("u2", "user"),
    work,
    message("a2", "assistant"),
    message("u3", "user"),
    message("a3", "assistant"),
  ];

  it("covers the edited message through the turns before the edit", () => {
    expect([...replacedIndexes(timeline, [{ from: "u2", after: "u2" }])]).toEqual([2, 3, 4]);
    expect([...replacedIndexes(timeline, [{ from: "u1", after: "u2" }])]).toEqual([0, 1, 2, 3, 4]);
  });

  it("runs to the end until the edit shows up", () => {
    expect([...replacedIndexes(timeline, [{ from: "u3", after: "u3" }])]).toEqual([5, 6]);
  });

  it("ignores an edit whose messages are gone", () => {
    expect(replacedIndexes(timeline, [{ from: "gone", after: "u2" }]).size).toBe(0);
  });
});

describe("replaceNote", () => {
  it("quotes the first line of the old message", () => {
    expect(replaceNote("Make it red")).toBe(
      "Replace my earlier message 'Make it red' with this and redo from there; ignore what came after.",
    );
    expect(replaceNote("Make it red\nand round")).toContain("'Make it red…'");
  });
});
