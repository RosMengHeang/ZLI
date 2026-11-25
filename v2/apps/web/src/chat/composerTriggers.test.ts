import type { FileListEntry, SkillListResult, ThreadMessageProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import type { Buddy } from "../teammates/buddies.js";
import { leadingMentions } from "../teammates/teammates.js";
import type { MentionOption } from "./composerTriggers.js";
import {
  addChip,
  type ComposerChip,
  detectTrigger,
  fileMention,
  matchCommands,
  matchFiles,
  matchSkills,
  mentionedSkills,
  replaceTrigger,
  skillChoices,
  withChips,
  withPersonChips,
  withSkillRequests,
} from "./composerTriggers.js";
import {
  type ContextChoice,
  matchContext,
  pullRequestBlock,
  recentTranscript,
  TERMINAL_LINES,
  terminalTail,
  withContextBlocks,
} from "./contextSources.js";

describe("detectTrigger", () => {
  it("reads @ anywhere, as a file or teammate query", () => {
    expect(detectTrigger("look at @src/ap", 15)).toEqual({ kind: "file", query: "src/ap", start: 8, end: 15 });
    expect(detectTrigger("@", 1)).toEqual({ kind: "file", query: "", start: 0, end: 1 });
  });

  it("ignores an @ inside a word, such as an email address", () => {
    expect(detectTrigger("mail me@host", 12)).toBeUndefined();
    expect(detectTrigger("@a@b", 4)).toBeUndefined();
  });

  it("reads $ as a skill but not as money", () => {
    expect(detectTrigger("try $rev", 8)).toEqual({ kind: "skill", query: "rev", start: 4, end: 8 });
    expect(detectTrigger("costs $5", 8)).toBeUndefined();
    expect(detectTrigger("costs $10k", 10)).toBeUndefined();
    expect(detectTrigger("$a.b", 4)).toBeUndefined();
  });

  it("opens commands only for the first word of the message", () => {
    expect(detectTrigger("/comp", 5)).toEqual({ kind: "command", query: "comp", start: 0, end: 5 });
    expect(detectTrigger("run /comp", 9)).toBeUndefined();
    expect(detectTrigger("/usr/bin", 8)).toBeUndefined();
  });

  it("closes once a space follows the word, and reads only up to the caret", () => {
    expect(detectTrigger("@src ", 5)).toBeUndefined();
    expect(detectTrigger("@src/app.ts and", 4)).toEqual({ kind: "file", query: "src", start: 0, end: 4 });
  });
});

describe("replaceTrigger", () => {
  it("swaps the word for the pick and leaves one space", () => {
    expect(replaceTrigger("see @ap now", { start: 4, end: 7 }, "@src/app.ts")).toEqual({
      text: "see @src/app.ts now",
      caret: 16,
    });
    expect(replaceTrigger("$re", { start: 0, end: 3 }, "$review")).toEqual({ text: "$review ", caret: 8 });
  });

  it("drops the rest of the word when the caret sat inside it", () => {
    expect(replaceTrigger("@srcxyz tail", { start: 0, end: 4 }, "@src/a.ts").text).toBe("@src/a.ts tail");
  });

  it("removes the word entirely for a command that runs at once", () => {
    expect(replaceTrigger("/new", { start: 0, end: 4 }, "")).toEqual({ text: "", caret: 0 });
  });
});

describe("fileMention", () => {
  it("quotes a path with a space", () => {
    expect(fileMention("src/app.ts")).toBe("@src/app.ts");
    expect(fileMention("docs/My Notes.md")).toBe('@"docs/My Notes.md"');
  });
});

describe("matchFiles", () => {
  const entries: FileListEntry[] = [
    { path: "README.md" },
    { path: "src/app.ts" },
    { path: "src/chat/Composer.tsx", status: "modified" },
    { path: "src/gone.ts", status: "deleted" },
  ];

  it("puts changed files first when nothing is typed, and skips deleted ones", () => {
    expect(matchFiles("", entries)).toEqual(["src/chat/Composer.tsx", "README.md", "src/app.ts"]);
  });

  it("matches the path fuzzily", () => {
    expect(matchFiles("cmpsr", entries)).toEqual(["src/chat/Composer.tsx"]);
    expect(matchFiles("app", entries)[0]).toBe("src/app.ts");
    expect(matchFiles("gone", entries)).toEqual([]);
  });
});

describe("skills", () => {
  const result = {
    skills: [
      { name: "review", description: "Review a diff", scope: "user", enabled: true, path: "/s/review" },
      { name: "off", description: "Turned off", scope: "user", enabled: false, path: "/s/off" },
      { name: "release", description: "Cut a release", scope: "project", enabled: true, path: "/p/release" },
    ],
    found: [
      {
        name: "review",
        description: "Other copy",
        scope: "user",
        path: "/c",
        dir: ".claude/skills",
        agents: ["claude-code"],
      },
      { name: "codex-only", description: "x", scope: "user", path: "/a", dir: ".agents/skills", agents: ["codex"] },
      {
        name: "tidy",
        description: "Tidy imports",
        scope: "user",
        path: "/t",
        dir: ".claude/skills",
        agents: ["claude-code"],
      },
    ],
    libraryPath: "/s",
    sync: { enabled: true, outcomes: [] },
  } as SkillListResult;

  it("lists enabled skills and the agent's own, once per name", () => {
    expect(skillChoices(result, "claude-code").map((skill) => skill.name)).toEqual(["release", "review", "tidy"]);
    expect(skillChoices(result, "claude-code").find((skill) => skill.name === "review")?.description).toBe(
      "Review a diff",
    );
  });

  it("ranks name starts before matches in the description", () => {
    const choices = skillChoices(result, "claude-code");
    expect(matchSkills("re", choices).map((skill) => skill.name)).toEqual(["release", "review"]);
    expect(matchSkills("imports", choices).map((skill) => skill.name)).toEqual(["tidy"]);
  });

  it("finds $name mentions of known skills only", () => {
    expect(mentionedSkills("$review this, then $tidy. $5 and $nope", new Set(["review", "tidy"]))).toEqual([
      "review",
      "tidy",
    ]);
  });

  it("asks agents other than Codex for the skill by name", () => {
    expect(withSkillRequests("$review the diff", ["review"], "claude-code")).toBe(
      "$review the diff\n\nUse the review skill.",
    );
    expect(withSkillRequests("$review the diff", ["review"], "codex")).toBe("$review the diff");
    expect(withSkillRequests("plain", [], "claude-code")).toBe("plain");
  });
});

describe("matchCommands", () => {
  it("filters by name first, then description", () => {
    const commands = [
      { name: "new", description: "Start a new chat" },
      { name: "model", description: "Pick the model" },
      { name: "compact", description: "Summarize the conversation" },
    ];
    expect(matchCommands("m", commands).map((command) => command.name)).toEqual(["model", "compact"]);
    expect(matchCommands("summ", commands).map((command) => command.name)).toEqual(["compact"]);
    expect(matchCommands("", commands)).toHaveLength(3);
  });
});

describe("the # trigger", () => {
  it("reads # anywhere as a context query, but not a heading or a word with two of them", () => {
    expect(detectTrigger("see #", 5)).toEqual({ kind: "context", query: "", start: 4, end: 5 });
    expect(detectTrigger("fix #pr", 7)).toEqual({ kind: "context", query: "pr", start: 4, end: 7 });
    expect(detectTrigger("##", 2)).toBeUndefined();
    expect(detectTrigger("a#b#c", 5)).toBeUndefined();
    expect(detectTrigger("C#", 2)).toBeUndefined();
    expect(detectTrigger("# Title", 7)).toBeUndefined();
  });
});

const choice = (kind: ContextChoice["kind"], label: string, detail?: string): ContextChoice => ({
  key: `${kind}:${label}`,
  kind,
  label,
  detail,
  load: async () => `block for ${label}`,
});

describe("matchContext", () => {
  const choices = [
    choice("terminal", "npm test"),
    choice("chat", "Fix the login page", "main"),
    choice("pullRequest", "#12 Speed up search", "Open"),
    choice("diff", "Uncommitted changes", "3 files"),
  ];

  it("keeps the groups in order with no query", () => {
    expect(matchContext("", choices).map((entry) => entry.kind)).toEqual(["diff", "chat", "pullRequest", "terminal"]);
  });

  it("matches the label fuzzily and a group by its short name", () => {
    expect(matchContext("login", choices).map((entry) => entry.label)).toEqual(["Fix the login page"]);
    expect(matchContext("pr", choices).map((entry) => entry.kind)).toContain("pullRequest");
    expect(matchContext("diff", choices).map((entry) => entry.kind)).toEqual(["diff"]);
    expect(matchContext("zzz", choices)).toEqual([]);
  });
});

describe("chips on send", () => {
  const owl: MentionOption = { name: "Owl", buddy: "sky" as Buddy, provider: "", detail: "Reviewer", kind: "buddy" };
  const chips: ComposerChip[] = [
    { kind: "person", key: "person:owl", label: "Owl", option: owl },
    { kind: "file", key: "file:src/a b.ts", label: "a b.ts", path: "src/a b.ts" },
    { kind: "skill", key: "skill:review", label: "review", name: "review" },
    {
      kind: "context",
      key: "context:diff",
      label: "Uncommitted changes",
      choice: choice("diff", "Uncommitted changes"),
    },
  ];

  it("puts files, then skill requests, then the # blocks after the text", () => {
    expect(
      withChips("check this", chips, { knownSkills: new Set(), provider: "claude-code", blocks: ["### Context: x"] }),
    ).toBe(
      'check this\n\n<zli-context kind="mentions">\n@"src/a b.ts"\n\nUse the review skill.\n</zli-context>\n\n### Context: x',
    );
  });

  it("gives Codex a picked skill as $name", () => {
    expect(withChips("go", chips.slice(2, 3), { knownSkills: new Set(), provider: "codex", blocks: [] })).toBe(
      'go\n\n<zli-context kind="mentions">\n$review\n</zli-context>',
    );
  });

  it("asks once for a skill that is both typed and picked", () => {
    expect(
      withChips("$review it", chips.slice(2, 3), {
        knownSkills: new Set(["review"]),
        provider: "claude-code",
        blocks: [],
      }),
    ).toBe('$review it\n\n<zli-context kind="mentions">\nUse the review skill.\n</zli-context>');
  });

  it("calls the picked people at the start, where the chat routes from", () => {
    expect(withPersonChips(chips, "check this")).toBe("@Owl check this");
    expect(withPersonChips(chips.slice(1), "check this")).toBe("check this");
    expect(leadingMentions(withPersonChips(chips, "check this"), ["Owl"])).toEqual({
      names: ["Owl"],
      rest: "check this",
    });
  });

  it("adds a chip once", () => {
    expect(addChip(addChip([], chips[0] as ComposerChip), chips[0] as ComposerChip)).toHaveLength(1);
  });
});

describe("context blocks", () => {
  it("appends blocks after the message and keeps only the last terminal lines", () => {
    expect(withContextBlocks("hi", ["### Context: a\n\nbody"])).toBe("hi\n\n### Context: a\n\nbody");
    expect(withContextBlocks("", ["x", " "])).toBe("x");
    const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
    const tail = terminalTail(`${lines}\n\n`).split("\n");
    expect(tail).toHaveLength(TERMINAL_LINES);
    expect(tail.at(-1)).toBe("line 100");
  });

  it("sends a chat's latest messages under its title", () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      messageId: `m${index}`,
      threadId: "t",
      role: index % 2 === 0 ? "user" : "assistant",
      text: `message ${index}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    })) as unknown as ThreadMessageProjection[];
    const block = recentTranscript("Fix login", messages);
    expect(
      block.startsWith('<zli-context kind="chat" label="Chat · Fix login">\n### Context: the chat "Fix login"'),
    ).toBe(true);
    expect(block).toContain("(2 earlier messages left out.)");
    expect(block).toContain("Agent: message 9");
    expect(block).not.toContain("message 1\n");
  });

  it("writes a pull request as number, title, link, and state", () => {
    const block = pullRequestBlock({
      number: 12,
      title: "Speed up search",
      url: "https://github.com/o/r/pull/12",
      state: "OPEN",
      isDraft: false,
      headRefName: "search",
      baseRefName: "main",
    });
    expect(block).toBe(
      '<zli-context kind="pullRequest" label="PR #12 Speed up search">\n### Context: pull request #12 Speed up search\n\nhttps://github.com/o/r/pull/12\nState: open\nBranch: search into main\n</zli-context>',
    );
  });
});
