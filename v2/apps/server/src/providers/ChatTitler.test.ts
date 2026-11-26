import type {
  RpcRequest,
  RuntimeEventEnvelope,
  RuntimeProjection,
  ThreadMessageProjection,
  ThreadProjection,
} from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import type { Engine } from "../orchestration/Engine.js";
import { ChatTitler, cleanTitle } from "./ChatTitler.js";

const threadId = "00000000-0000-4000-8000-000000000901";

function setup(thread: Partial<ThreadProjection> = {}) {
  const sent: RpcRequest[] = [];
  const asked: string[] = [];
  let listener: ((envelope: RuntimeEventEnvelope) => void) | undefined;
  const messages: ThreadMessageProjection[] = [];
  const engine = {
    projection: async () =>
      ({
        threads: [{ threadId, worktreeId: "w", provider: "codex", status: "working", capabilities: {}, ...thread }],
        messages,
      }) as unknown as RuntimeProjection,
    subscribe: (next: (envelope: RuntimeEventEnvelope) => void) => {
      listener = next;
      return () => undefined;
    },
    dispatchPromise: async (request: RpcRequest) => {
      sent.push(request);
      return { status: "accepted" };
    },
  } as unknown as Engine;
  const titler = new ChatTitler(engine, async (message) => {
    asked.push(message);
    return '"Fix ACP connection retries."';
  });
  const say = async (messageId: string, text: string, role: "user" | "assistant" = "user") => {
    const message = { messageId, threadId, role, text } as ThreadMessageProjection;
    messages.push(message);
    listener?.({ event: { type: "thread.message.appended", message } } as unknown as RuntimeEventEnvelope);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { titler, sent, asked, say };
}

describe("ChatTitler", () => {
  it("titles a chat once, from its first message only", async () => {
    const { sent, asked, say } = await setup();
    await say("m1", "so now im using zli and found many issue like the acp connected not working well");
    await say("m2", "Here is what I found.", "assistant");
    await say("m3", "also fix the permission picker");
    expect(asked).toEqual(["so now im using zli and found many issue like the acp connected not working well"]);
    expect(sent.map((request) => request.command)).toEqual([
      { type: "thread.title", threadId, title: "Fix ACP connection retries" },
    ]);
  });

  it("leaves chats that already have a title, carry on another, or were started by an agent", async () => {
    for (const thread of [{ chatTitle: "Kept" }, { continues: "earlier" }, { startedBy: "agent" }]) {
      const { sent, say } = await setup(thread as Partial<ThreadProjection>);
      await say("m1", "hello");
      expect(sent).toEqual([]);
    }
  });

  it("keeps the title to one clean line", () => {
    expect(cleanTitle('Title: "Login page bug".\nMore text')).toBe("Login page bug");
    expect(cleanTitle("  \n")).toBeUndefined();
    expect(cleanTitle("x".repeat(100))?.length).toBe(80);
  });
});
