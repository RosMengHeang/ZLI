import { describe, expect, it } from "vitest";

import { ProjectionStore } from "./ProjectionStore.js";

const id = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;

function projection(terminalStatus: string) {
  return {
    environment: { environmentId: id("01"), label: "Local", protocolVersion: 1, capabilities: {} },
    projects: [],
    worktrees: [{ worktreeId: id("11"), projectId: id("12"), path: "/repo", branch: "main", status: "ready" }],
    threads: [],
    terminals: [
      { terminalId: id("31"), worktreeId: id("11"), title: "Terminal", status: terminalStatus, lastSequence: 0 },
    ],
    browserTabs: [],
    attention: [],
    lastSequence: 0,
  };
}

function envelope(sequence: number, event: unknown) {
  return {
    protocolVersion: 1,
    sequence,
    eventId: id(String(sequence + 40)),
    occurredAt: "2026-09-21T00:00:00.000Z",
    event,
  };
}

const detected = {
  type: "devserver.detected",
  devServer: { worktreeId: id("11"), terminalId: id("31"), url: "http://localhost:5173/", port: 5173 },
};

describe("ProjectionStore dev servers", () => {
  it("records a detected server and removes it when it stops", () => {
    const store = new ProjectionStore();
    store.replace(projection("running"));
    expect(store.apply(envelope(1, detected))).toBe("applied");
    expect(store.current()?.devServers).toEqual([{ ...detected.devServer, detectedAt: "2026-09-21T00:00:00.000Z" }]);
    expect(store.apply(envelope(2, { type: "devserver.stopped", terminalId: id("31"), port: 5173 }))).toBe("applied");
    expect(store.current()?.devServers).toEqual([]);
  });

  it("drops a server when its terminal exits", () => {
    const store = new ProjectionStore();
    store.replace(projection("running"));
    store.apply(envelope(1, detected));
    store.apply(envelope(2, { type: "terminal.status.changed", terminalId: id("31"), status: "exited" }));
    expect(store.current()?.devServers).toEqual([]);
  });
});
