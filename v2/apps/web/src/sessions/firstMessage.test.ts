import type { TerminalProjection, ThreadProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { firstMessageStep, terminalFirstMessage } from "./firstMessage.js";
import type { AgentSession } from "./sessions.js";

const base: AgentSession = {
  sessionId: "s1",
  worktreeId: "w1",
  provider: "droid",
  status: "starting",
  mode: "chat",
};

const thread = (status: ThreadProjection["status"]) => ({ threadId: "t1", status }) as ThreadProjection;
const terminal = (status: TerminalProjection["status"]) => ({ terminalId: "x1", status }) as TerminalProjection;

describe("first message delivery", () => {
  it("waits for an idle chat or a running CLI and drops it when the agent is gone", () => {
    expect(firstMessageStep(undefined)).toEqual({ kind: "wait" });
    expect(firstMessageStep({ ...base, thread: thread("starting") })).toEqual({ kind: "wait" });
    expect(firstMessageStep({ ...base, thread: thread("idle") })).toEqual({ kind: "chat", threadId: "t1" });
    expect(firstMessageStep({ ...base, thread: thread("failed") })).toEqual({ kind: "drop" });
    expect(firstMessageStep({ ...base, terminal: terminal("starting") })).toEqual({ kind: "wait" });
    expect(firstMessageStep({ ...base, terminal: terminal("running") })).toEqual({
      kind: "terminal",
      terminalId: "x1",
    });
    expect(firstMessageStep({ ...base, terminal: terminal("exited") })).toEqual({ kind: "drop" });
    expect(
      firstMessageStep({
        ...base,
        pending: {
          sessionId: "s1",
          worktreeId: "w1",
          provider: "droid",
          mode: "chat",
          createdAt: "",
          errorMessage: "x",
        },
      }),
    ).toEqual({ kind: "drop" });
  });

  it("pastes multi-line text so its newlines do not submit early", () => {
    expect(terminalFirstMessage("fix it")).toEqual({ body: "fix it", submit: "\r" });
    expect(terminalFirstMessage("a\nb").body).toBe("\u001b[200~a\nb\u001b[201~");
  });
});
