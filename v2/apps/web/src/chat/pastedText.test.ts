import { describe, expect, it } from "vitest";

import {
  attachmentOnlyMessage,
  isLongPaste,
  LONG_PASTE_CHARS,
  LONG_PASTE_LINES,
  lineCount,
  textBase64,
} from "./pastedText.js";

describe("pasted text", () => {
  it("counts lines without the trailing newline", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("one")).toBe(1);
    expect(lineCount("one\ntwo\n")).toBe(2);
    expect(lineCount("one\r\ntwo\rthree")).toBe(3);
  });

  it("treats many lines or many characters as a long paste", () => {
    expect(isLongPaste("short note")).toBe(false);
    expect(isLongPaste(Array.from({ length: LONG_PASTE_LINES }, (_, index) => `line ${index}`).join("\n"))).toBe(true);
    expect(isLongPaste("x".repeat(LONG_PASTE_CHARS))).toBe(true);
    expect(isLongPaste("x".repeat(LONG_PASTE_CHARS - 1))).toBe(false);
  });

  it("encodes text as UTF-8 base64", () => {
    expect(textBase64("hi")).toBe("aGk=");
    expect(atob(textBase64("é"))).toBe("\u00c3\u00a9");
    const large = "ab".repeat(70_000);
    expect(atob(textBase64(large))).toBe(large);
  });

  it("describes what was attached when the message is empty", () => {
    expect(attachmentOnlyMessage(2, 0)).toBe("See the attached images.");
    expect(attachmentOnlyMessage(0, 1)).toBe("See the attached text.");
    expect(attachmentOnlyMessage(0, 2)).toBe("See the attached texts.");
    expect(attachmentOnlyMessage(1, 1)).toBe("See the attached files.");
    expect(attachmentOnlyMessage(0, 0, 1)).toBe("See the attached files.");
  });
});
