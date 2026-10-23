import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ProviderCapabilities, ThreadId } from "@zli-v2/contracts";

import type { ProviderAdapter, ProviderEvent, ProviderKind, ProviderSession } from "./ProviderService.js";

/**
 * Deterministic provider used only by the Electron integration harness.
 * It exercises the structured provider boundary without spawning another CLI.
 */
export class MockProviderAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = "codex";
  readonly capabilities: ProviderCapabilities = {
    exactResume: true,
    structuredApproval: true,
    structuredUserInput: true,
    conversationRollback: true,
    modelSwitch: "unsupported",
  };

  private readonly sessions = new Map<string, ProviderSession>();
  private readonly turns = new Map<string, unknown[]>();
  /** Turns paused on an approval or question, finished once the person answers. */
  private readonly pausedTurns = new Map<string, string>();
  private readonly listeners = new Set<(event: ProviderEvent) => void>();

  async startSession(input: { threadId: ThreadId; cwd: string }): Promise<ProviderSession> {
    const session: ProviderSession = {
      threadId: input.threadId,
      provider: this.provider,
      cwd: input.cwd,
      status: "idle",
    };
    this.sessions.set(input.threadId, session);
    this.turns.set(input.threadId, []);
    return session;
  }

  async sendTurn(input: { threadId: ThreadId; text: string; model?: string }): Promise<{ turnId: string }> {
    const session = this.context(input.threadId);
    const turnId = randomUUID();
    session.status = "working";
    setTimeout(() => {
      if (!this.sessions.has(input.threadId)) return;
      if (input.text.includes("[hold]")) {
        this.emit({ type: "turn.started", threadId: input.threadId, turnId });
        return;
      }
      if (input.text.includes("[approval]")) {
        session.status = "waiting";
        this.pausedTurns.set(input.threadId, turnId);
        this.emit({
          type: "approval.requested",
          threadId: input.threadId,
          requestId: randomUUID(),
          payload: { title: "Mock provider approval", command: "echo integration-check" },
        });
        return;
      }
      if (input.text.includes("[input]")) {
        session.status = "waiting";
        this.pausedTurns.set(input.threadId, turnId);
        this.emit({
          type: "user-input.requested",
          threadId: input.threadId,
          requestId: randomUUID(),
          payload: { title: "Mock provider input", fields: ["answer"] },
        });
        return;
      }
      this.emit({ type: "turn.started", threadId: input.threadId, turnId });
      // "[write notes.md]" writes that file in the worktree, standing in for an agent's edit.
      const write = /\[write (\w[\w.-]*)\]/u.exec(input.text)?.[1];
      if (write) {
        try {
          writeFileSync(join(session.cwd, write), `Written by the mock agent: ${input.text}\n`);
        } catch {
          // The harness only checks the reply when the folder cannot be written.
        }
      }
      // "[reads]" stands in for an agent looking around: several file reads, then one command.
      if (input.text.includes("[reads]")) {
        for (const file of ["src/app.ts", "src/routes.ts", "package.json"]) {
          this.emit({
            type: "activity",
            threadId: input.threadId,
            turnId,
            activity: {
              activityId: randomUUID(),
              kind: "file-read",
              title: `Read ${file}`,
              status: "completed",
              files: [file],
            },
          });
        }
        this.emit({
          type: "activity",
          threadId: input.threadId,
          turnId,
          activity: { activityId: randomUUID(), kind: "command", title: "npm test", status: "completed" },
        });
      }
      this.emit({ type: "assistant.delta", threadId: input.threadId, turnId, text: `Mock response: ${input.text}` });
      if (input.text.includes("[html]")) {
        this.emit({
          type: "assistant.delta",
          threadId: input.threadId,
          turnId,
          text: '\n\n```html\n<!doctype html>\n<html><body><h1 style="color:#2563eb">Mock card</h1></body></html>\n```\n',
        });
      }
      if (input.text.includes("[usage]")) {
        this.emit({
          type: "usage",
          threadId: input.threadId,
          turnId,
          usage: {
            inputTokens: 12_400,
            cachedInputTokens: 8_000,
            outputTokens: 1_250,
            costUsd: 0.042,
            contextTokens: 13_650,
            contextWindow: 200_000,
          },
        });
      }
      this.emit({ type: "turn.completed", threadId: input.threadId, turnId, status: "completed" });
      session.status = "idle";
    }, 5);
    return { turnId };
  }

  async interruptTurn(input: { threadId: ThreadId; turnId?: string }): Promise<void> {
    this.context(input.threadId).status = "idle";
  }

  async respondToRequest(input: { threadId: ThreadId; requestId: string; decision: unknown }): Promise<void> {
    this.finishPausedTurn(input.threadId);
  }

  async respondToUserInput(input: {
    threadId: ThreadId;
    requestId: string;
    answers: Record<string, string>;
  }): Promise<void> {
    this.finishPausedTurn(input.threadId);
  }

  async stopSession(input: { threadId: ThreadId }): Promise<void> {
    this.context(input.threadId);
    this.sessions.delete(input.threadId);
  }

  listSessions(): ReadonlyArray<ProviderSession> {
    return [...this.sessions.values()];
  }

  hasSession(input: { threadId: ThreadId }): boolean {
    return this.sessions.has(input.threadId);
  }

  async readThread(input: { threadId: ThreadId }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    this.context(input.threadId);
    return { threadId: input.threadId, turns: this.turns.get(input.threadId) ?? [] };
  }

  async rollbackThread(input: {
    threadId: ThreadId;
    numTurns: number;
  }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    this.context(input.threadId);
    const turns = this.turns.get(input.threadId) ?? [];
    turns.splice(Math.max(0, turns.length - input.numTurns));
    return { threadId: input.threadId, turns };
  }

  async stopAll(): Promise<void> {
    this.sessions.clear();
    this.turns.clear();
  }

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private context(threadId: ThreadId): ProviderSession {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error(`Mock provider session does not exist: ${threadId}`);
    return session;
  }

  private finishPausedTurn(threadId: ThreadId): void {
    const session = this.context(threadId);
    const turnId = this.pausedTurns.get(threadId);
    this.pausedTurns.delete(threadId);
    session.status = "idle";
    if (!turnId) return;
    setTimeout(() => {
      if (!this.sessions.has(threadId)) return;
      this.emit({ type: "turn.completed", threadId, turnId, status: "completed" });
    }, 5);
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
