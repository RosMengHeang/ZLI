import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AgentHistoryScanner } from "./AgentHistoryScanner.js";
import { parseClaudeTranscript, parseCodexThreadNames, parseCodexTranscript, titleFrom } from "./agentHistory.js";

const jsonl = (...lines: unknown[]) => `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

const claudeChat = (cwd: string, sessionId = "c1") =>
  jsonl(
    { type: "custom-title", customTitle: "", sessionId },
    {
      type: "user",
      sessionId,
      cwd,
      timestamp: "2026-11-01T10:00:00.000Z",
      message: { role: "user", content: "<command-name>/clear</command-name>" },
    },
    {
      type: "user",
      sessionId,
      cwd,
      timestamp: "2026-11-01T10:00:01.000Z",
      message: { role: "user", content: "Fix the login bug\n<system-reminder>ignore</system-reminder>" },
    },
    {
      type: "assistant",
      sessionId,
      cwd,
      message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "hmm" }] },
    },
    {
      type: "assistant",
      sessionId,
      cwd,
      message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Looking now." }] },
    },
    {
      type: "assistant",
      sessionId,
      cwd,
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    },
    {
      type: "user",
      sessionId,
      cwd,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file" }] },
    },
    {
      type: "assistant",
      sessionId,
      cwd,
      message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "Fixed it." }] },
    },
    {
      type: "user",
      sessionId,
      cwd,
      isSidechain: true,
      message: { role: "user", content: "sub-agent prompt" },
    },
  );

describe("parseClaudeTranscript", () => {
  it("keeps what the person and Claude wrote and drops tool calls, commands, and side chats", () => {
    const chat = parseClaudeTranscript(claudeChat("/work/app"), "fallback");
    expect(chat).toMatchObject({
      source: "claude-code",
      providerSessionId: "c1",
      cwd: "/work/app",
      title: "Fix the login bug",
      model: "claude-opus-5-5",
      createdAt: "2026-11-01T10:00:00.000Z",
      omitted: 0,
    });
    expect(chat?.messages).toEqual([
      { role: "user", text: "Fix the login bug" },
      { role: "assistant", text: "Looking now.\n\nFixed it." },
    ]);
  });

  it("prefers the person's own title", () => {
    const contents = `${claudeChat("/work/app")}${jsonl({ type: "custom-title", customTitle: "Login fix", sessionId: "c1" })}`;
    expect(parseClaudeTranscript(contents, "c1")?.title).toBe("Login fix");
  });

  it("skips transcripts with nothing the person typed", () => {
    expect(parseClaudeTranscript(jsonl({ type: "summary", summary: "x" }), "c1")).toBeNull();
  });
});

describe("parseCodexTranscript", () => {
  const rollout = jsonl(
    { timestamp: "2026-11-02T08:00:00.000Z", type: "session_meta", payload: { id: "x1", cwd: "C:\\work\\api" } },
    {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…" }] },
    },
    { type: "event_msg", payload: { type: "user_message", message: "Add a health check" } },
    { type: "event_msg", payload: { type: "agent_message", message: "Adding it." } },
    { type: "event_msg", payload: { type: "token_count", info: {} } },
    { type: "event_msg", payload: { type: "agent_message", message: "Done." } },
  );

  it("reads the typed messages without the context Codex adds", () => {
    const chat = parseCodexTranscript(rollout, new Map());
    expect(chat).toMatchObject({
      source: "codex",
      providerSessionId: "x1",
      cwd: "C:\\work\\api",
      title: "Add a health check",
    });
    expect(chat?.messages).toEqual([
      { role: "user", text: "Add a health check" },
      { role: "assistant", text: "Adding it.\n\nDone." },
    ]);
  });

  it("falls back to response items when a rollout has no typed messages", () => {
    const chat = parseCodexTranscript(
      jsonl(
        { type: "session_meta", payload: { id: "x2", cwd: "/w" } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }],
          },
        },
        {
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Rename the API" }] },
        },
        {
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Renamed." }] },
        },
      ),
      new Map(),
    );
    expect(chat?.messages).toEqual([
      { role: "user", text: "Rename the API" },
      { role: "assistant", text: "Renamed." },
    ]);
  });

  it("uses the newest name from the session index", () => {
    const names = parseCodexThreadNames(
      jsonl(
        { id: "x1", thread_name: "Health" },
        { id: "x1", thread_name: "Health check" },
        { id: "x1", thread_name: "" },
      ),
    );
    expect(parseCodexTranscript(rollout, names)?.title).toBe("Health check");
  });
});

describe("titleFrom", () => {
  it("uses the first line and shortens long ones", () => {
    expect(titleFrom("\n  First   line\nsecond")).toBe("First line");
    expect(titleFrom("a".repeat(120))).toHaveLength(80);
  });
});

describe("AgentHistoryScanner", () => {
  it("groups chats by folder, newest first, and marks the ones already in ZLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "zli-history-"));
    try {
      const project = join(home, "app");
      await mkdir(project);
      const claudeDir = join(home, ".claude", "projects", "app");
      await mkdir(join(claudeDir, "c2"), { recursive: true });
      await writeFile(join(claudeDir, "c1.jsonl"), claudeChat(project, "c1"));
      await writeFile(join(claudeDir, "c2", "subagent.jsonl"), claudeChat(project, "nested"));
      const codexDir = join(home, ".codex", "sessions", "2026", "11", "02");
      await mkdir(codexDir, { recursive: true });
      await writeFile(
        join(codexDir, "rollout-2026-11-02T08-00-00-x1.jsonl"),
        jsonl(
          { type: "session_meta", payload: { id: "x1", cwd: join(home, "gone") } },
          { type: "event_msg", payload: { type: "user_message", message: "Hello" } },
        ),
      );
      const scanner = new AgentHistoryScanner({ home, env: {} });
      const folders = await scanner.scan(new Set(["c1"]));
      expect(folders.map((folder) => [folder.name, folder.exists, folder.chats.length])).toEqual(
        expect.arrayContaining([
          ["app", true, 1],
          ["gone", false, 1],
        ]),
      );
      const app = folders.find((folder) => folder.name === "app");
      expect(app?.chats[0]).toMatchObject({ providerSessionId: "c1", imported: true, messageCount: 2 });
      const loaded = await scanner.load("codex", "x1");
      expect(loaded?.messages).toEqual([{ role: "user", text: "Hello" }]);
      expect(await scanner.load("codex", "missing")).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
