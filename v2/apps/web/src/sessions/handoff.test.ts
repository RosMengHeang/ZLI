import type { ThreadMessageProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import {
  canHandOff,
  HANDOFF_FILE_NAME,
  handoffMessage,
  handoffTranscript,
  inlineFirstMessage,
  RECENT_CONTEXT_CHAR_BUDGET,
  RECENT_CONTEXT_FILE_NAME,
  recentContextMessage,
} from "./handoff.js";
import { parseWorkbenchState } from "./workbench.js";

const threadId = "00000000-0000-4000-8000-000000000101" as ThreadMessageProjection["threadId"];

function message(index: number, role: ThreadMessageProjection["role"], text: string): ThreadMessageProjection {
  return { messageId: `m${index}`, threadId, role, text };
}

describe("handoff", () => {
  it("writes the conversation with speakers and attachment paths", () => {
    const transcript = handoffTranscript(
      [
        message(1, "system", "internal"),
        message(2, "user", "Fix the login form"),
        { ...message(3, "assistant", "Done, see below."), attachments: [] },
        {
          ...message(4, "user", "Here is the error"),
          attachments: [{ name: "error.png", mimeType: "image/png", path: "C:/a/error.png" }],
        },
        message(5, "agent", "Tests pass on my side"),
      ],
      "Codex",
    );
    expect(transcript.text).toBe(
      [
        "## User\n\nFix the login form",
        "## Codex\n\nDone, see below.",
        "## User\n\nHere is the error\n- Attached: error.png (C:/a/error.png)",
        "## Message from another agent\n\nTests pass on my side",
      ].join("\n\n"),
    );
    expect(transcript).toMatchObject({ included: 4, omitted: 0 });
  });

  it("keeps the newest messages within the budget and says how many were left out", () => {
    const messages = Array.from({ length: 10 }, (_, index) => message(index, "user", `${index}`.repeat(40)));
    const transcript = handoffTranscript(messages, "Codex", 150);
    expect(transcript.included).toBe(2);
    expect(transcript.omitted).toBe(8);
    expect(transcript.text.startsWith("(8 earlier messages left out)")).toBe(true);
    expect(transcript.text).toContain("9".repeat(40));
    expect(transcript.text).not.toContain("0".repeat(40));
  });

  it("shortens one very long message from the middle", () => {
    const long = `start${"x".repeat(20_000)}end`;
    const { text } = handoffTranscript([message(1, "assistant", long)], "Claude Code");
    expect(text).toContain("start");
    expect(text).toContain("end");
    expect(text).toMatch(/characters left out/u);
    expect(text.length).toBeLessThan(9_000);
  });

  it("builds the first message with the title, the branch, and the next step", () => {
    const result = handoffMessage({
      title: "Continue: Fix the login form",
      fromName: "Codex",
      branch: "feat/login",
      messages: [message(1, "user", "Fix the login form")],
      note: "  Add a test for the empty password case.  ",
    });
    expect(result.text.split("\n\n")).toEqual([
      "Continue: Fix the login form",
      `You are taking over this work from Codex in the same folder, on branch feat/login. Its changes are already on disk. The conversation so far is in ${HANDOFF_FILE_NAME}.`,
      "Add a test for the empty password case.",
    ]);
    expect(result.transcript.name).toBe(HANDOFF_FILE_NAME);
    expect(result.transcript.text).toContain("# Conversation with Codex");
    expect(result.text).not.toContain("\u2014");
  });

  it("starts a new chat with only the end of the earlier one", () => {
    const messages = Array.from({ length: 20 }, (_, index) => message(index, "user", `${index}`.repeat(2_000)));
    const result = recentContextMessage({ title: "Fix the login form", name: "Codex", branch: "main", messages });
    expect(result.transcript.name).toBe(RECENT_CONTEXT_FILE_NAME);
    expect(result.transcript.text.startsWith("# Earlier chat with Codex")).toBe(true);
    expect(result.transcript.text.length).toBeLessThan(RECENT_CONTEXT_CHAR_BUDGET + 500);
    expect(result.omitted).toBeGreaterThan(0);
    expect(result.transcript.text).toContain("19".repeat(1_000));
    expect(result.text.split("\n\n")[0]).toBe("Continue: Fix the login form");
    expect(result.text).toContain(RECENT_CONTEXT_FILE_NAME);
    expect(result.text).not.toContain("\u2014");
  });

  it("is offered once the chat has something in it", () => {
    const session = { thread: { threadId } as never };
    expect(canHandOff(session, [])).toBe(false);
    expect(canHandOff(session, [message(1, "system", "started")])).toBe(false);
    expect(canHandOff(session, [message(1, "user", "Hi")])).toBe(true);
    expect(canHandOff({}, [message(1, "user", "Hi")])).toBe(false);
  });

  it("pastes the file after the message for terminals", () => {
    expect(inlineFirstMessage("Go", { name: "a.md", text: "body\n" })).toBe("Go\n\na.md:\n\nbody");
    expect(inlineFirstMessage("Go", undefined)).toBe("Go");
  });

  it("reads first messages saved as strings and as objects", () => {
    const state = parseWorkbenchState(
      JSON.stringify({
        firstMessages: {
          a: "hello",
          b: { text: "Continue", file: { name: "h.md", text: "body" } },
          c: { text: "" },
          d: 4,
        },
      }),
    );
    expect(state.firstMessages).toEqual({
      a: { text: "hello" },
      b: { text: "Continue", file: { name: "h.md", text: "body" } },
    });
  });
});
