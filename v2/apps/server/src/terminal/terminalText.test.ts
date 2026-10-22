import { describe, expect, it } from "vitest";

import { readableTerminalText } from "./terminalText.js";

describe("readableTerminalText", () => {
  it("removes color codes and window titles", () => {
    expect(readableTerminalText("\u001b]0;title\u0007\u001b[32mok\u001b[0m done\r\n").text).toBe("ok done");
  });

  it("keeps the final text of carriage-return redraws and applies backspaces", () => {
    expect(readableTerminalText("Loading 10%\rLoading 100%\nabx\bc\n").text).toBe("Loading 100%\nabc");
  });

  it("puts rows apart when a program moves the cursor, and squeezes blank lines", () => {
    expect(readableTerminalText("first\u001b[2;1Hsecond\n\n\n\nthird").text).toBe("first\nsecond\n\nthird");
  });

  it("keeps only the last lines", () => {
    const result = readableTerminalText("a\nb\nc\nd", 2);
    expect(result).toEqual({ text: "c\nd", cutLines: true });
  });
});
