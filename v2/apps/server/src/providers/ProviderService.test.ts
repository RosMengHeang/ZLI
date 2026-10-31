import { ThreadId } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import {
  type ProviderAdapter,
  type ProviderEvent,
  ProviderRegistry,
  ProviderService,
  type ProviderSession,
} from "./ProviderService.js";

const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000601");

class FakeAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  readonly capabilities = {
    exactResume: true,
    structuredApproval: true,
    structuredUserInput: true,
    conversationRollback: true,
    modelSwitch: "unsupported" as const,
  };
  readonly calls: string[] = [];
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly sessions = new Map<string, ProviderSession>();
  failStart?: Error;

  async startSession(input: { threadId: ThreadId; cwd: string }): Promise<ProviderSession> {
    if (this.failStart) throw this.failStart;
    this.calls.push(`start:${input.cwd}`);
    const session = { threadId: input.threadId, provider: this.provider, cwd: input.cwd, status: "idle" as const };
    this.sessions.set(input.threadId, session);
    return session;
  }

  async sendTurn(input: { threadId: ThreadId; text: string }): Promise<{ turnId: string }> {
    this.calls.push(`turn:${input.text}`);
    this.emit({ type: "assistant.delta", threadId: input.threadId, turnId: "turn-1", text: "ok" });
    return { turnId: "turn-1" };
  }

  async interruptTurn(): Promise<void> {
    this.calls.push("interrupt");
  }
  async respondToRequest(): Promise<void> {
    this.calls.push("approval");
  }
  async respondToUserInput(): Promise<void> {
    this.calls.push("input");
  }
  async stopSession(input: { threadId: ThreadId }): Promise<void> {
    this.calls.push("stop");
    if (!this.sessions.delete(input.threadId)) throw new Error(`Fake session does not exist: ${input.threadId}`);
  }
  /** Stands in for a session the adapter dropped without saying so, such as a process that died mid-call. */
  forget(threadId: ThreadId): void {
    this.sessions.delete(threadId);
  }
  listSessions(): ProviderSession[] {
    return [...this.sessions.values()];
  }
  hasSession(input: { threadId: ThreadId }): boolean {
    return this.sessions.has(input.threadId);
  }
  async readThread(input: { threadId: ThreadId }): Promise<{ threadId: ThreadId; turns: unknown[] }> {
    return { threadId: input.threadId, turns: [] };
  }
  async rollbackThread(input: {
    threadId: ThreadId;
    numTurns: number;
  }): Promise<{ threadId: ThreadId; turns: unknown[] }> {
    return { threadId: input.threadId, turns: [input.numTurns] };
  }
  async stopAll(): Promise<void> {
    this.sessions.clear();
  }
  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Like the real adapters, a closed session is forgotten before anyone hears about it. */
  emit(event: ProviderEvent): void {
    if (event.type === "session.closed") this.sessions.delete(event.threadId);
    this.notify(event);
  }
  /** Reports an event without touching the adapter's sessions. */
  notify(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

describe("ProviderService", () => {
  it("routes sessions and turns through the selected provider and fans out canonical events", async () => {
    const adapter = new FakeAdapter();
    const service = new ProviderService(new ProviderRegistry([adapter]));
    const events: ProviderEvent[] = [];
    service.subscribe((event) => events.push(event));

    await expect(
      service.startSession({ provider: "codex", threadId, cwd: "C:/workspace/tree" }),
    ).resolves.toMatchObject({ threadId, provider: "codex" });
    await expect(service.sendTurn({ threadId, text: "hello" })).resolves.toEqual({ turnId: "turn-1" });
    expect(events).toEqual([{ type: "assistant.delta", threadId, turnId: "turn-1", text: "ok" }]);
    expect(adapter.calls).toEqual(["start:C:/workspace/tree", "turn:hello"]);
  });

  it("rejects unsupported rollback before changing provider state", async () => {
    const adapter = new FakeAdapter();
    adapter.capabilities.conversationRollback = false;
    const service = new ProviderService(new ProviderRegistry([adapter]));
    await service.startSession({ provider: "codex", threadId, cwd: "C:/workspace/tree" });

    await expect(service.rollbackThread({ threadId, numTurns: 1 })).rejects.toMatchObject({ code: "unsupported" });
    expect(adapter.calls).toEqual(["start:C:/workspace/tree"]);
  });

  it("shares one discovery run between concurrent callers and caches its result", async () => {
    let versionReads = 0;
    const service = new ProviderService(new ProviderRegistry([new FakeAdapter()]), {
      pathEntries: ["/tools"],
      platform: "linux",
      fileExists: (filePath) => filePath === "/tools/codex",
      readVersion: async () => {
        versionReads += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "codex 1.0.0";
      },
    });

    const [first, second] = await Promise.all([service.discoverProviders(), service.discoverProviders()]);
    const third = await service.discoverProviders();

    expect(versionReads).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first[0]).toMatchObject({ provider: "codex", status: "found", version: "codex 1.0.0" });
  });

  it("discovers injected CLIs without starting a provider session", async () => {
    const adapter = new FakeAdapter();
    const service = new ProviderService(new ProviderRegistry([adapter]), {
      pathEntries: ["/tools"],
      platform: "linux",
      fileExists: (filePath) => filePath === "/tools/claude",
    });

    const discovery = await service.discoverProviders();
    expect(discovery.slice(4).map((entry) => [entry.provider, entry.status])).toEqual([
      ["opencode", "missing"],
      ["gemini", "missing"],
      ["copilot", "missing"],
      ["kimi", "missing"],
      ["qwen", "missing"],
      ["goose", "missing"],
    ]);
    expect(discovery.slice(0, 4)).toEqual([
      {
        provider: "codex",
        displayName: "Codex",
        status: "missing",
        reason: "Codex CLI was not found on PATH or in known install locations.",
      },
      { provider: "claude-code", displayName: "Claude Code", status: "found", path: "/tools/claude" },
      {
        provider: "cursor-agent",
        displayName: "Cursor",
        status: "missing",
        reason: "Cursor CLI was not found on PATH or in known install locations.",
      },
      {
        provider: "droid",
        displayName: "Droid",
        status: "missing",
        reason: "Droid CLI was not found on PATH or in known install locations.",
      },
    ]);
    expect(adapter.calls).toEqual([]);
    expect(service.listSessions()).toEqual([]);
  });

  it("preserves a missing CLI error instead of hiding it", async () => {
    const adapter = new FakeAdapter();
    const failure = new Error("Claude Code CLI was not found on PATH or in known install locations.");
    Object.assign(failure, { code: "cli_missing" });
    adapter.failStart = failure;
    const service = new ProviderService(new ProviderRegistry([adapter]));

    await expect(service.startSession({ provider: "codex", threadId, cwd: "C:/workspace/tree" })).rejects.toMatchObject(
      {
        code: "cli_missing",
        message: "Claude Code CLI was not found on PATH or in known install locations.",
      },
    );
    expect(service.listSessions()).toEqual([]);
  });

  it("starts a thread again after its agent process closed on its own", async () => {
    const adapter = new FakeAdapter();
    const service = new ProviderService(new ProviderRegistry([adapter]));
    const seen: boolean[] = [];
    service.subscribe((event) => {
      if (event.type === "session.closed") seen.push(service.hasSession(event.threadId));
    });
    await service.startSession({ provider: "codex", threadId, cwd: "C:/workspace/tree" });

    adapter.emit({ type: "session.closed", threadId, reason: "Codex exited (1)." });
    expect(seen).toEqual([false]);
    expect(service.hasSession(threadId)).toBe(false);
    await expect(service.sendTurn({ threadId, text: "hello" })).rejects.toMatchObject({ code: "session_missing" });

    await service.startSession({ provider: "codex", threadId, cwd: "C:/workspace/tree" });
    await expect(service.sendTurn({ threadId, text: "hello" })).resolves.toEqual({ turnId: "turn-1" });
    expect(adapter.calls).toEqual(["start:C:/workspace/tree", "start:C:/workspace/tree", "turn:hello"]);
  });

  it("keeps a newer session when the old process reports closing late", async () => {
    const adapter = new FakeAdapter();
    const service = new ProviderService(new ProviderRegistry([adapter]));
    await service.startSession({ provider: "codex", threadId, cwd: "C:/workspace/tree" });

    adapter.notify({ type: "session.closed", threadId, reason: "old exit" });
    expect(service.hasSession(threadId)).toBe(true);
    await expect(service.startSession({ provider: "codex", threadId, cwd: "C:/workspace/tree" })).rejects.toMatchObject(
      { code: "session_exists" },
    );
  });

  it("forgets a session on stop even when the adapter already lost it", async () => {
    const adapter = new FakeAdapter();
    const service = new ProviderService(new ProviderRegistry([adapter]));
    await service.startSession({ provider: "codex", threadId, cwd: "C:/workspace/tree" });
    adapter.forget(threadId);

    await expect(service.stopSession({ threadId })).rejects.toThrow("does not exist");
    expect(service.hasSession(threadId)).toBe(false);
    await expect(
      service.startSession({ provider: "codex", threadId, cwd: "C:/workspace/tree" }),
    ).resolves.toMatchObject({ threadId });
  });

  it("fails closed for unknown providers and sessions", async () => {
    const service = new ProviderService(new ProviderRegistry([]));
    await expect(
      service.startSession({ provider: "cursor-agent", threadId, cwd: "C:/workspace/tree" }),
    ).rejects.toMatchObject({ code: "provider_missing" });
    await expect(service.sendTurn({ threadId, text: "hello" })).rejects.toMatchObject({ code: "session_missing" });
  });
});
