import type { TerminalClientMessage } from "@zli-v2/client-runtime";
import type { RpcResponse } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { ids } from "./fixtures.js";
import type { LinkSnapshot } from "./link.js";
import { TerminalFeed } from "./terminalFeed.js";

const commandId = "8b9c0d1e-2f3a-4b8c-9d9e-0f1a2b3c4d5e" as RpcResponse["commandId"];

function fakeLink() {
  const linkListeners = new Set<() => void>();
  const terminalListeners = new Set<(message: TerminalClientMessage) => void>();
  let snapshot = { state: { kind: "online", host: "h" }, generation: 1 } as LinkSnapshot;
  const attached: string[] = [];
  const commands: { type: string; data?: string }[] = [];
  let output = "$ ls\nREADME.md";
  return {
    attached,
    commands,
    setOutput(text: string) {
      output = text;
    },
    reconnect() {
      snapshot = { ...snapshot, generation: snapshot.generation + 1 };
      for (const listener of linkListeners) listener();
    },
    emit(message: TerminalClientMessage) {
      for (const listener of terminalListeners) listener(message);
    },
    link: {
      getSnapshot: () => snapshot,
      subscribe(listener: () => void) {
        linkListeners.add(listener);
        return () => linkListeners.delete(listener);
      },
      subscribeTerminal(listener: (message: TerminalClientMessage) => void) {
        terminalListeners.add(listener);
        return () => terminalListeners.delete(listener);
      },
      attachTerminal(terminalId: string) {
        attached.push(terminalId);
      },
      async command(command: { type: string; data?: string }): Promise<RpcResponse> {
        commands.push(command);
        if (command.type === "terminal.read") {
          return { commandId, accepted: true, result: { terminalId: ids.shell, text: output, truncated: false } };
        }
        return { commandId, accepted: true };
      },
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("TerminalFeed", () => {
  it("attaches, reads, and reads again when output arrives", async () => {
    const fake = fakeLink();
    const feed = new TerminalFeed(fake.link, ids.shell, 1);
    feed.start();
    await settle();
    expect(fake.attached).toEqual([ids.shell]);
    expect(feed.getSnapshot()).toMatchObject({ text: "$ ls\nREADME.md", loaded: true });

    fake.setOutput("$ ls\nREADME.md\n$ ");
    fake.emit({
      kind: "stream",
      message: { kind: "chunk", chunk: { terminalId: ids.shell, sequence: 5, bytesBase64: "JCA=" } },
    } as TerminalClientMessage);
    await settle();
    expect(feed.getSnapshot().text).toBe("$ ls\nREADME.md\n$ ");

    fake.emit({
      kind: "stream",
      message: { kind: "exit", terminalId: ids.shell, code: 0, signal: null },
    } as TerminalClientMessage);
    await settle();
    expect(feed.getSnapshot().exited).toBe(true);
    feed.stop();
  });

  it("attaches again after a reconnect and sends typed input", async () => {
    const fake = fakeLink();
    const feed = new TerminalFeed(fake.link, ids.shell, 1);
    feed.start();
    await settle();
    fake.reconnect();
    await settle();
    expect(fake.attached).toEqual([ids.shell, ids.shell]);
    await expect(feed.write("ls\r")).resolves.toBeUndefined();
    expect(fake.commands.at(-1)).toEqual({ type: "terminal.write", terminalId: ids.shell, data: "ls\r" });
    feed.stop();
  });
});
