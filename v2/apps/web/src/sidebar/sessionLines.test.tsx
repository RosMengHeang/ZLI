// @vitest-environment jsdom

import { type RuntimeProjection, ThreadId } from "@zli-v2/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { AskLine, LiveStep, previewLine, ReplyPreview } from "./sessionLines.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => document.body.replaceChildren());

const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000401");

async function text(projection: Partial<RuntimeProjection>, node: ReactNode): Promise<string> {
  const bridge = {
    runtime: {
      dispatch: async () => undefined,
      getProjection: async () => projection,
      onProjection: () => () => undefined,
    },
  } as unknown as ZliBridge;
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => createRoot(container).render(<RuntimeProvider bridge={bridge}>{node}</RuntimeProvider>));
  return container.textContent ?? "";
}

describe("previewLine", () => {
  it("takes the first line that says something, without its Markdown marks", () => {
    expect(previewLine("\n## Done\n\nThe **tests** pass.")).toBe("Done");
    expect(previewLine("- Renamed `first_run` in ~~two~~ three files")).toBe("Renamed first_run in two three files");
    expect(previewLine("```ts\nconst a = 1;\n```\nIt works.")).toBe("It works.");
    expect(previewLine("| - | - |\n---\n1. Ship it")).toBe("Ship it");
    expect(previewLine("")).toBe("");
  });
});

describe("the line under a chat", () => {
  const activities = [
    { activityId: "a1", threadId, turnId: "t1", kind: "command", title: "npm test", status: "completed" },
    { activityId: "a2", threadId, turnId: "t2", kind: "file-read", title: "Read src/app.ts", status: "completed" },
    { activityId: "a3", threadId, turnId: "t2", kind: "command", title: "npm run build", status: "running" },
    { activityId: "a4", threadId, turnId: "t2", kind: "file-read", title: "Read README.md", status: "completed" },
  ] as RuntimeProjection["activities"];

  it("says the step a working agent is on, from this turn only", async () => {
    expect(await text({ activities }, <LiveStep threadId={threadId} turnId="t2" />)).toBe("npm run build");
    expect(await text({ activities }, <LiveStep threadId={threadId} turnId="t1" />)).toBe("npm test");
    expect(await text({ activities }, <LiveStep threadId={threadId} turnId="t3" />)).toBe("Thinking");
  });

  it("says what a waiting agent asked for", async () => {
    const approval = [
      { requestId: "r1", threadId, kind: "approval", payload: { command: "rm -rf dist" } },
    ] as RuntimeProjection["requests"];
    expect(await text({ requests: approval }, <AskLine threadId={threadId} provider="droid" />)).toBe(
      "Run a command: rm -rf dist",
    );
    const question = [
      {
        requestId: "r2",
        threadId,
        kind: "user-input",
        payload: { questions: [{ id: "q", question: "Which branch?" }] },
      },
    ] as RuntimeProjection["requests"];
    expect(await text({ requests: question }, <AskLine threadId={threadId} provider="droid" />)).toBe("Which branch?");
    expect(await text({}, <AskLine threadId={threadId} provider="droid" />)).toBe("Waiting for your answer");
  });

  it("opens with the agent's last reply for a chat that finished", async () => {
    const messages = [
      { messageId: "m1", threadId, role: "user", text: "Fix it" },
      { messageId: "m2", threadId, turnId: "t1", role: "assistant", text: "Looking." },
      { messageId: "m3", threadId, turnId: "t2", role: "assistant", text: "**Fixed** the route.\n\nDetails follow." },
    ] as RuntimeProjection["messages"];
    expect(await text({ messages }, <ReplyPreview threadId={threadId} />)).toBe("Fixed the route.");
    expect(await text({}, <ReplyPreview threadId={threadId} />)).toBe("Finished");
  });
});
