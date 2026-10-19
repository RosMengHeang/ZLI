import { describe, expect, it } from "vitest";

import { ThreadId } from "@zli-v2/contracts";

import type { ProviderEvent } from "./ProviderService.js";
import { TerminalCompatibilityAdapter, discoverTerminalProvider } from "./TerminalCompatibilityAdapter.js";

const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000801");

class FakeChild {
  readonly writes: string[] = [];
  killed = false;
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly closeListeners = new Set<() => void>();
  stdin = { write: (data: string) => this.writes.push(data) };
  stdout = {
    on: (_event: string, listener: (chunk: string) => void) => {
      this.dataListeners.add(listener);
    },
  };
  stderr = { on: () => undefined };
  once = (event: string, listener: () => void) => {
    if (event === "close") this.closeListeners.add(listener);
  };
  kill = () => {
    this.killed = true;
    for (const listener of this.closeListeners) listener();
  };
  emit(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }
}

describe("TerminalCompatibilityAdapter", () => {
  it("discovers the first available canonical CLI without shell interpolation", async () => {
    await expect(
      discoverTerminalProvider({
        provider: "cursor-agent",
        candidates: ["cursor-agent", "cursor-agent.cmd"],
        resolve: async (candidate) => (candidate.endsWith(".cmd") ? candidate : undefined),
      }),
    ).resolves.toEqual({ provider: "cursor-agent", command: "cursor-agent.cmd" });
  });

  it("provides reduced-capability sessions through a structured adapter", async () => {
    const child = new FakeChild();
    const adapter = new TerminalCompatibilityAdapter({
      provider: "opencode",
      command: "opencode",
      spawn: () => child as never,
    });
    const events: ProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.startSession({ threadId, cwd: "C:/workspace/tree" });
    await expect(adapter.sendTurn({ threadId, text: "hello" })).resolves.toMatchObject({ turnId: expect.any(String) });
    child.emit("OpenCode response\n");

    expect(child.writes).toEqual(["hello\n"]);
    expect(events[0]).toMatchObject({ type: "assistant.delta", threadId, text: "OpenCode response\n" });
    expect(adapter.capabilities).toMatchObject({
      exactResume: false,
      structuredApproval: false,
      conversationRollback: false,
    });
    await adapter.stopAll();
    expect(child.killed).toBe(true);
  });
});
