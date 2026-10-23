import { describe, expect, it } from "vitest";

import {
  addCodeReference,
  clearCodeReferences,
  codeReferencesFor,
  referenceLabel,
  removeCodeReference,
  withReferences,
} from "./codeReferences.js";

describe("withReferences", () => {
  it("writes each reference ahead of the message, with snippets fenced and labeled by language", () => {
    expect(
      withReferences(
        [
          { id: "a", path: "src/app.ts", startLine: 3, endLine: 5, snippet: "one\ntwo\nthree" },
          { id: "b", path: "docs/guide.md", startLine: 8, endLine: 8 },
          { id: "c", path: "Makefile" },
        ],
        "What does this do?",
      ),
    ).toBe(
      "`src/app.ts` lines 3-5:\n```ts\none\ntwo\nthree\n```\n\n`docs/guide.md` line 8\n\n`Makefile`\n\nWhat does this do?",
    );
  });

  it("uses a longer fence when the snippet contains one, and sends references alone without a message", () => {
    expect(withReferences([{ id: "a", path: "README.md", startLine: 1, snippet: "```sh\nls\n```" }], "")).toBe(
      "`README.md` line 1:\n````md\n```sh\nls\n```\n````",
    );
    expect(withReferences([], "plain")).toBe("plain");
  });
});

describe("code reference store", () => {
  it("replaces a repeated file and range, removes one, and clears a chat", () => {
    const thread = "thread-store-test";
    addCodeReference(thread, { path: "a.ts", startLine: 1, endLine: 2, snippet: "old" });
    addCodeReference(thread, { path: "a.ts", startLine: 1, endLine: 2, snippet: "new" });
    addCodeReference(thread, { path: "b.ts" });
    expect(codeReferencesFor(thread).map((reference) => [reference.id, reference.snippet])).toEqual([
      ["a.ts:1-2", "new"],
      ["b.ts:-", undefined],
    ]);
    removeCodeReference(thread, "b.ts:-");
    expect(codeReferencesFor(thread)).toHaveLength(1);
    clearCodeReferences(thread);
    expect(codeReferencesFor(thread)).toEqual([]);
    expect(referenceLabel({ id: "x", path: "src/a.ts", startLine: 4, endLine: 4 })).toBe("a.ts:4");
    expect(referenceLabel({ id: "x", path: "src/a.ts", startLine: 4, endLine: 9 })).toBe("a.ts:4-9");
    expect(referenceLabel({ id: "x", path: "src/a.ts" })).toBe("a.ts");
  });
});
