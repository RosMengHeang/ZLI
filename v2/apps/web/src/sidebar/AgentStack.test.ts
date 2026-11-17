import type { ThreadProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import type { AgentSession } from "../sessions/sessions.js";
import { chatAgents } from "./AgentStack.js";

const thread = (provider: string, updatedAt: string) => ({ provider, updatedAt }) as ThreadProjection;
const session = (provider: string, threads: ThreadProjection[] = []) =>
  ({ sessionId: "s", worktreeId: "w", provider, threads, status: "ready", mode: "chat" }) as AgentSession;

describe("chatAgents", () => {
  it("lists the agent now first, then the ones the chat switched from, then teammates, each once", () => {
    const chat = session("claude-code", [
      thread("codex", "2026-11-18T10:00:00Z"),
      thread("droid", "2026-11-18T11:00:00Z"),
      thread("claude-code", "2026-11-18T12:00:00Z"),
    ]);
    expect(chatAgents(chat, [session("gemini"), session("codex")])).toEqual([
      "claude-code",
      "droid",
      "codex",
      "gemini",
    ]);
    expect(chatAgents(session("codex"))).toEqual(["codex"]);
  });
});
