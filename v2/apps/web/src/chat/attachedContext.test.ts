import { describe, expect, it } from "vitest";

import { attachedSection, attachedText, MENTIONS_KIND, splitAttachedContext } from "./attachedContext.js";
import { withChips } from "./composerTriggers.js";
import { contextBlock } from "./contextSources.js";

const diff = contextBlock(
  "diff",
  "Uncommitted changes · 2 files",
  "uncommitted changes, 2 files",
  "```diff\n-old\n+new\n```",
);
const terminal = contextBlock("terminal", "npm test · last 80 lines", 'terminal "npm test"', "```\nPASS a\n```");

describe("splitAttachedContext", () => {
  it("takes the # blocks off the end and keeps what was typed", () => {
    const text = `why did it fail\n\n${diff}\n\n${terminal}`;
    const split = splitAttachedContext(text);
    expect(split.body).toBe("why did it fail");
    expect(split.attachments.map((attachment) => [attachment.kind, attachment.label])).toEqual([
      ["diff", "Uncommitted changes · 2 files"],
      ["terminal", "npm test · last 80 lines"],
    ]);
    expect(attachedText(split.attachments[0] as never)).toBe("```diff\n-old\n+new\n```");
    expect(split.attachments[0]?.content).toBe("### Context: uncommitted changes, 2 files\n\n```diff\n-old\n+new\n```");
  });

  it("reads files and skills from the picked-chip section", () => {
    const chips = [
      { kind: "file", key: "f1", label: "a b.ts", path: "src/a b.ts" },
      { kind: "file", key: "f2", label: "c.ts", path: "src/c.ts" },
      { kind: "skill", key: "s", label: "review", name: "review" },
    ] as const;
    const sent = withChips("check this", chips, { knownSkills: new Set(), provider: "claude-code", blocks: [diff] });
    expect(splitAttachedContext(sent)).toEqual({
      body: "check this",
      attachments: [expect.objectContaining({ kind: "diff" })],
      files: ["src/a b.ts", "src/c.ts"],
      skills: ["review"],
    });
    const codex = withChips("go", chips.slice(2), { knownSkills: new Set(), provider: "codex", blocks: [] });
    expect(splitAttachedContext(codex)).toEqual({ body: "go", attachments: [], files: [], skills: ["review"] });
  });

  it("shows a message with only a block as no text and one tag", () => {
    expect(splitAttachedContext(diff)).toEqual({
      body: "",
      attachments: [expect.objectContaining({ kind: "diff" })],
      files: [],
      skills: [],
    });
  });

  it("leaves old messages without markers as they were", () => {
    const old = 'why\n\n### Context: terminal "npm test", last 80 lines\n\n```\nPASS a\n```';
    expect(splitAttachedContext(old)).toEqual({ body: old, attachments: [], files: [], skills: [] });
    expect(splitAttachedContext("check this\n\n@src/a.ts\n\nUse the review skill.").body).toBe(
      "check this\n\n@src/a.ts\n\nUse the review skill.",
    );
  });

  it("leaves text that only looks like a block alone", () => {
    const cases = [
      // Typed after the block, so it is not at the end.
      `${diff}\n\nand then this`,
      // Not closed.
      'see <zli-context kind="diff">\nbody',
      '<zli-context kind="diff">\nbody',
      // Not on its own line.
      'a <zli-context kind="diff">\nbody\n</zli-context>',
      // Closed twice.
      `${diff}\n</zli-context>`,
      "just </zli-context> here",
    ];
    for (const text of cases)
      expect(splitAttachedContext(text)).toEqual({ body: text, attachments: [], files: [], skills: [] });
  });

  it("keeps a chat's quoted blocks inside the block that quotes them", () => {
    const chat = attachedSection("chat", "Chat · Fix login", `User: look\n\n${diff}\n\nAgent: done`);
    const split = splitAttachedContext(`compare\n\n${chat}`);
    expect(split.body).toBe("compare");
    expect(split.attachments).toHaveLength(1);
    expect(split.attachments[0]?.content).toContain("Agent: done");
  });

  it("reads Windows line endings", () => {
    const text = `hi\r\n\r\n${diff.replaceAll("\n", "\r\n")}`;
    const split = splitAttachedContext(text);
    expect(split.body).toBe("hi");
    expect(split.attachments).toHaveLength(1);
  });

  it("keeps quotes and line breaks out of the label", () => {
    expect(attachedSection("chat", 'The "big"\nchat', "x")).toBe(
      '<zli-context kind="chat" label="The \'big\' chat">\nx\n</zli-context>',
    );
    expect(attachedSection(MENTIONS_KIND, "", "@a.ts")).toBe('<zli-context kind="mentions">\n@a.ts\n</zli-context>');
  });
});
