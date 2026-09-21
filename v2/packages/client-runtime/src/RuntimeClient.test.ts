import { describe, expect, it, vi } from "vitest";

import { RuntimeProjection } from "@zli-v2/contracts";

import { RuntimeClient, type RuntimeTransport } from "./RuntimeClient.js";

const environmentId = "30000000-0000-4000-8000-000000000001";
const projectId = "40000000-0000-4000-8000-000000000001";
const commandId = "10000000-0000-4000-8000-000000000001";

class FakeTransport implements RuntimeTransport {
  readonly sent: unknown[] = [];
  #messageListeners = new Set<(message: unknown) => void>();
  #closeListeners = new Set<() => void>();

  send(message: unknown): void {
    this.sent.push(message);
  }

  close(): void {}

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  receive(message: unknown): void {
    for (const listener of this.#messageListeners) listener(message);
  }

  disconnect(): void {
    for (const listener of this.#closeListeners) listener();
  }
}

function projection(lastSequence = 0): RuntimeProjection {
  return RuntimeProjection.parse({
    environment: {
      environmentId,
      label: "Local",
      protocolVersion: 1,
      capabilities: { worktrees: true },
    },
    projects: [],
    worktrees: [],
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence,
  });
}

async function connectedClient() {
  const transport = new FakeTransport();
  const connecting = RuntimeClient.connect({
    token: "test-token",
    environmentId,
    connectTransport: async () => transport,
    sleep: async () => {},
  });
  await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
  expect(transport.sent[0]).toEqual({
    type: "hello",
    protocolVersion: 1,
    token: "test-token",
    environmentId,
  });
  transport.receive({
    type: "hello",
    protocolVersion: 1,
    environment: projection().environment,
  });
  return { client: await connecting, transport };
}

describe("RuntimeClient", () => {
  it("correlates a command response without replaying the command", async () => {
    const { client, transport } = await connectedClient();

    const pending = client.command({
      protocolVersion: 1,
      commandId,
      command: { type: "project.register", path: "C:/work/example" },
    });
    transport.receive({
      type: "response",
      response: { commandId, accepted: true, result: { projectId } },
    });

    await expect(pending).resolves.toEqual({ commandId, accepted: true, result: { projectId } });
    expect(transport.sent.filter((message: any) => message.type === "command")).toHaveLength(1);
  });

  it("requests a fresh projection when an event sequence has a gap", async () => {
    const { client, transport } = await connectedClient();
    transport.receive({ type: "projection", projection: projection(3) });

    transport.receive({
      type: "event",
      envelope: {
        protocolVersion: 1,
        sequence: 5,
        eventId: "20000000-0000-4000-8000-000000000005",
        occurredAt: "2026-09-21T00:00:00.000Z",
        event: { type: "project.registered", project: { projectId, path: "C:/work", name: "work" } },
      },
    });

    expect(transport.sent.at(-1)).toEqual({ type: "projection.get" });
    expect(client.projection()?.lastSequence).toBe(3);
  });

  it("ignores duplicate events already represented by the projection", async () => {
    const { client, transport } = await connectedClient();
    transport.receive({ type: "projection", projection: projection(3) });
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);

    transport.receive({
      type: "event",
      envelope: {
        protocolVersion: 1,
        sequence: 3,
        eventId: "20000000-0000-4000-8000-000000000003",
        occurredAt: "2026-09-21T00:00:00.000Z",
        event: { type: "project.registered", project: { projectId, path: "C:/work", name: "work" } },
      },
    });

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("rejects a handshake from a different environment", async () => {
    const transport = new FakeTransport();
    const connecting = RuntimeClient.connect({
      token: "test-token",
      environmentId,
      connectTransport: async () => transport,
    });
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    transport.receive({
      type: "hello",
      protocolVersion: 1,
      environment: { ...projection().environment, environmentId: "30000000-0000-4000-8000-000000000099" },
    });

    await expect(connecting).rejects.toThrow("environment mismatch");
  });

  it("reconnects subscriptions from the last committed sequence", async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    const transports = [first, second];
    const clientPromise = RuntimeClient.connect({
      token: "test-token",
      environmentId,
      connectTransport: async () => transports.shift()!,
      sleep: async () => {},
    });
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    first.receive({ type: "hello", protocolVersion: 1, environment: projection().environment });
    const client = await clientPromise;
    first.receive({ type: "projection", projection: projection(7) });

    first.disconnect();
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    second.receive({ type: "hello", protocolVersion: 1, environment: projection().environment });
    await vi.waitFor(() =>
      expect(second.sent).toContainEqual({ type: "subscribe", afterSequence: 7 }),
    );

    expect(client.projection()?.lastSequence).toBe(7);
  });

  it("rejects malformed handshake messages", async () => {
    const transport = new FakeTransport();
    const connecting = RuntimeClient.connect({
      token: "test-token",
      environmentId,
      connectTransport: async () => transport,
    });
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));

    transport.receive({ type: "hello", protocolVersion: 99, environment: {} });

    await expect(connecting).rejects.toThrow("invalid server message");
  });

  it("fails in-flight commands on disconnect instead of replaying them", async () => {
    const { client, transport } = await connectedClient();
    const pending = client.command({
      protocolVersion: 1,
      commandId,
      command: { type: "project.register", path: "C:/work/example" },
    });

    transport.disconnect();

    await expect(pending).rejects.toThrow("connection closed before command completed");
    expect(transport.sent.filter((message: any) => message.type === "command")).toHaveLength(1);
    client.close();
  });

  it("attaches terminal streams and forwards validated snapshots and output", async () => {
    const { client, transport } = await connectedClient();
    const terminalId = "50000000-0000-4000-8000-000000000001";
    const messages: unknown[] = [];
    const unsubscribe = client.subscribeTerminal((message) => messages.push(message));
    client.attachTerminal(terminalId, 4);
    expect(transport.sent.at(-1)).toEqual({ type: "terminal.attach", terminalId, afterSequence: 4 });
    transport.receive({ type: "terminal.snapshot", snapshot: { terminalId, chunks: [], nextSequence: 4, truncated: false } });
    transport.receive({ type: "terminal.stream", message: { kind: "chunk", chunk: { terminalId, sequence: 5, bytesBase64: "aGk=" } } });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ kind: "snapshot", snapshot: { nextSequence: 4 } });
    expect(messages[1]).toMatchObject({ kind: "stream", message: { kind: "chunk" } });
    unsubscribe();
    client.close();
  });
});
