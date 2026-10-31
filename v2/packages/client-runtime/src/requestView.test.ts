import { describe, expect, it } from "vitest";

import { describeApproval, describeQuestions } from "./requestView.js";

describe("describeApproval", () => {
  it("shows a Codex command with only the decisions Codex offered", () => {
    const view = describeApproval("codex", {
      command: ["git", "push"],
      cwd: "/work/tree",
      reason: "Needs network",
      availableDecisions: ["accept", "decline", "cancel", { acceptWithExecpolicyAmendment: {} }],
    });
    expect(view.title).toBe("Run a command");
    expect(view.fields).toEqual([
      { label: "Command", value: "git push", mono: true },
      { label: "In", value: "/work/tree", mono: true },
      { label: "Reason", value: "Needs network" },
    ]);
    expect(view.choices.map((choice) => [choice.label, choice.decision])).toEqual([
      ["Approve", { decision: "accept" }],
      ["Decline", { decision: "decline" }],
      ["Decline and stop", { decision: "cancel" }],
    ]);
  });

  it("offers approve for this chat on Codex file changes when no list is sent", () => {
    const view = describeApproval("codex", { grantRoot: "/work/tree", itemId: "i1" });
    expect(view.title).toBe("Change files");
    expect(view.choices.map((choice) => choice.label)).toEqual(["Approve", "Approve for this chat", "Decline"]);
  });

  it("names the MCP server and its question when Codex asks before a tool call", () => {
    const view = describeApproval("codex", {
      serverName: "zli-browser",
      message: 'Allow the zli-browser MCP server to run tool "open"?',
      _meta: { codex_approval_kind: "mcp_tool_call" },
      availableDecisions: ["accept", "acceptForSession", "decline"],
    });
    expect(view.title).toBe("Use an MCP tool");
    expect(view.fields).toEqual([
      { label: "Server", value: "zli-browser", mono: true },
      { label: "Request", value: 'Allow the zli-browser MCP server to run tool "open"?' },
    ]);
    expect(view.choices.map((choice) => choice.label)).toEqual(["Approve", "Approve for this chat", "Decline"]);
    expect(describeApproval("codex", { reason: "fetch", permissions: { network: {} } }).title).toBe(
      "Allow more access",
    );
  });

  it("uses the agent's own options for ACP requests", () => {
    const view = describeApproval("gemini", {
      toolName: "Edit README.md",
      input: { path: "README.md" },
      options: [
        { optionId: "a", name: "Allow", kind: "allow_once" },
        { optionId: "b", kind: "allow_always" },
        { optionId: "c", name: "Reject", kind: "reject_once" },
      ],
    });
    expect(view.title).toBe("Edit README.md");
    expect(view.fields).toEqual([{ label: "Path", value: "README.md", mono: true }]);
    expect(view.choices.map((choice) => [choice.label, choice.decision])).toEqual([
      ["Allow", { optionId: "a", approved: true }],
      ["Always allow", { optionId: "b", approved: true }],
      ["Reject", { optionId: "c", approved: false }],
    ]);
  });

  it("shows a Claude edit as the text it replaces", () => {
    const view = describeApproval("claude-code", {
      toolName: "Edit",
      input: { file_path: "src/a.ts", old_string: "let a = 1", new_string: "" },
    });
    expect(view.title).toBe("Change a file");
    expect(view.fields).toEqual([
      { label: "File", value: "src/a.ts", mono: true },
      { label: "Replace", value: "let a = 1", mono: true },
      { label: "With", value: "(nothing)", mono: true },
    ]);
    expect(view.choices.map((choice) => choice.label)).toEqual(["Approve", "Allow Edit for this chat", "Reject"]);
  });

  it("shows the command Droid wants to run and the plan it wants to leave spec mode with", () => {
    const command = describeApproval("droid", {
      toolName: "Execute",
      input: { command: "echo hi", riskLevel: "medium", summary: "Print hi" },
      toolUseId: "t1",
    });
    expect(command.title).toBe("Run a command");
    expect(command.fields).toEqual([{ label: "Command", value: "echo hi", mono: true }]);
    expect(command.choices.map((choice) => choice.label)).toEqual(["Approve", "Allow Execute for this chat", "Reject"]);

    const plan = describeApproval("droid", {
      toolName: "ExitSpecMode",
      input: { title: "Create note.txt", plan: "Create note.txt containing x." },
    });
    expect(plan.fields).toEqual([{ label: "Plan", value: "Create note.txt containing x.", mono: false }]);
  });

  it("falls back to approve and reject for anything else, and shortens long values", () => {
    const view = describeApproval("mock", { command: "x".repeat(700) });
    expect(view.fields[0]?.value).toHaveLength(601);
    expect(view.choices.map((choice) => choice.decision)).toEqual([{ approved: true }, { approved: false }]);
  });
});

describe("describeQuestions", () => {
  it("reads Codex questions, including other and secret answers", () => {
    expect(
      describeQuestions({
        questions: [
          { id: "q1", header: "Pick", question: "Which?", options: [{ label: "A" }], isOther: true },
          { id: "q2", header: "Token", question: "Token?", isSecret: true },
          { header: "no id" },
        ],
      }),
    ).toEqual([
      { id: "q1", header: "Pick", question: "Which?", options: [{ label: "A" }], allowOther: true, secret: false },
      { id: "q2", header: "Token", question: "Token?", options: [], allowOther: true, secret: true },
    ]);
  });

  it("asks for named fields, or one answer when the request says nothing usable", () => {
    expect(describeQuestions({ title: "Mock provider input", fields: ["answer"] })).toEqual([
      { id: "answer", question: "Mock provider input", options: [], allowOther: true, secret: false },
    ]);
    expect(describeQuestions({})).toEqual([
      { id: "answer", question: "The agent needs an answer", options: [], allowOther: true, secret: false },
    ]);
  });
});
