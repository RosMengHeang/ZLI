import { describe, expect, it } from "vitest";

import { ProjectionStore } from "./ProjectionStore.js";

const id = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;

function projection() {
  return {
    environment: { environmentId: id("01"), label: "Local", protocolVersion: 1, capabilities: {} },
    projects: [],
    worktrees: [],
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 0,
  };
}

function envelope(sequence: number, event: unknown) {
  return {
    protocolVersion: 1,
    sequence,
    eventId: id(String(sequence + 10).padStart(2, "0")),
    occurredAt: "2026-09-21T00:00:00.000Z",
    event,
  };
}

describe("ProjectionStore", () => {
  it("applies durable worktree, terminal, and review events without losing sequence", () => {
    const store = new ProjectionStore();
    store.replace(projection());
    expect(
      store.apply(
        envelope(1, {
          type: "worktree.create.requested",
          worktree: { worktreeId: id("11"), projectId: id("12"), path: "C:/repo", branch: "feature", status: "queued" },
          workspaceRoot: "C:/work",
          baseRef: "main",
        }),
      ),
    ).toBe("applied");
    expect(store.apply(envelope(2, { type: "worktree.status.changed", worktreeId: id("11"), status: "ready" }))).toBe(
      "applied",
    );
    expect(
      store.apply(
        envelope(3, {
          type: "review.updated",
          review: {
            worktreeId: id("11"),
            baseRef: "main",
            branch: "feature",
            state: "changes",
            files: [],
            conflictFiles: [],
            updatedAt: "2026-09-21T00:00:00.000Z",
          },
        }),
      ),
    ).toBe("applied");
    expect(store.current()?.worktrees[0]?.status).toBe("ready");
    expect(store.current()?.reviews?.[0]?.state).toBe("changes");
    expect(store.current()?.lastSequence).toBe(3);
  });

  it("applies browser tab updates as they arrive, including device viewports", () => {
    const store = new ProjectionStore();
    store.replace(projection());
    const tab = {
      browserTabId: id("21"),
      profileId: id("02"),
      worktreeId: id("11"),
      url: "http://127.0.0.1:5173/",
      title: "Dev",
      active: true,
      status: "idle",
    };
    expect(store.apply(envelope(1, { type: "browser.updated", tab }))).toBe("applied");
    const viewport = { width: 393, height: 852, deviceScaleFactor: 3, mobile: true };
    expect(store.apply(envelope(2, { type: "browser.updated", tab: { ...tab, viewport } }))).toBe("applied");
    expect(store.current()?.browserTabs).toEqual([{ ...tab, viewport }]);
    expect(store.apply(envelope(3, { type: "browser.closed", browserTabId: tab.browserTabId }))).toBe("applied");
    expect(store.current()?.browserTabs).toEqual([]);
    expect(store.current()?.lastSequence).toBe(3);
  });

  it("tells listeners whether a projection was replaced or advanced by one event", () => {
    const store = new ProjectionStore();
    const changes: unknown[] = [];
    store.subscribe((_projection, change) => changes.push(change));
    store.replace(projection());
    const event = envelope(1, { type: "browser.closed", browserTabId: id("21") });
    store.apply(event);

    expect(changes).toEqual([{ kind: "replace" }, { kind: "event", envelope: event }]);
  });

  it("asks for a fresh projection when it cannot fold an event locally", () => {
    const store = new ProjectionStore();
    store.replace(projection());
    expect(store.apply(envelope(1, { type: "diagnostics.bundle.requested", destinationPath: "C:/bundle.zip" }))).toBe(
      "gap",
    );
    expect(store.current()?.lastSequence).toBe(0);
  });

  it("follows a chat turn with an approval without asking for a fresh projection", () => {
    const store = new ProjectionStore();
    const threadId = id("31");
    const statuses: string[] = [];
    store.subscribe((next) => {
      const status = next.threads[0]?.status;
      if (status && statuses.at(-1) !== status) statuses.push(status);
    });
    store.replace({
      ...projection(),
      threads: [{ threadId, worktreeId: id("11"), provider: "codex", status: "idle", capabilities: {} }],
    });
    const request = { requestId: "r1", threadId, kind: "approval", payload: { command: "npm test" } };
    const events = [
      { type: "thread.send.requested", threadId, text: "Run the tests", permissionMode: "supervised" },
      { type: "thread.status.changed", threadId, status: "working", turnId: id("41") },
      { type: "thread.request.requested", request },
      { type: "thread.respond.requested", threadId, requestId: "r1", decision: "accept" },
      { type: "thread.request.resolved", threadId, requestId: "r1" },
      { type: "thread.status.changed", threadId, status: "idle" },
    ];
    events.forEach((event, index) => {
      expect(store.apply(envelope(index + 1, event))).toBe("applied");
      if (event.type === "thread.request.requested") {
        expect(store.current()?.requests).toEqual([request]);
        expect(store.current()?.attention.map((item) => item.id)).toEqual(["thread-request:r1"]);
      }
    });
    expect(statuses).toEqual(["idle", "working", "idle"]);
    expect(store.current()?.threads[0]?.permissionMode).toBe("supervised");
    expect(store.current()?.requests).toEqual([]);
    expect(store.current()?.attention).toEqual([]);
    expect(store.current()?.lastSequence).toBe(events.length);
  });

  it("projects an agent-to-agent message onto the target thread", () => {
    const store = new ProjectionStore();
    store.replace(projection());
    const threadA = id("31");
    const threadB = id("32");
    expect(
      store.apply(
        envelope(1, {
          type: "thread.a2a.delivered",
          projectId: id("12"),
          message: {
            messageId: "agent-1",
            threadId: threadB,
            role: "agent",
            text: "hello from A",
            sourceThreadId: threadA,
          },
        }),
      ),
    ).toBe("applied");
    expect(store.current()?.messages).toEqual([
      expect.objectContaining({ threadId: threadB, role: "agent", text: "hello from A", sourceThreadId: threadA }),
    ]);
    expect(JSON.stringify(store.current()?.projectContexts)).not.toContain("hello from A");
  });

  it("refreshes shared project context when worktrees and threads in that project change", () => {
    const store = new ProjectionStore();
    const projectA = id("12");
    const projectB = id("13");
    const worktreeA = id("11");
    const worktreeB = id("14");
    const threadA = id("31");
    const threadB = id("32");
    store.replace({
      ...projection(),
      projects: [
        { projectId: projectA, path: "C:/alpha", name: "alpha" },
        { projectId: projectB, path: "C:/beta", name: "beta" },
      ],
    });
    expect(
      store.apply(
        envelope(1, {
          type: "worktree.create.requested",
          worktree: {
            worktreeId: worktreeA,
            projectId: projectA,
            path: "C:/alpha/a",
            branch: "feature-a",
            status: "queued",
          },
          workspaceRoot: "C:/work",
        }),
      ),
    ).toBe("applied");
    expect(store.current()?.projectContexts?.[0]?.worktrees).toEqual([
      { worktreeId: worktreeA, path: "C:/alpha/a", branch: "feature-a", status: "queued" },
    ]);
    expect(store.current()?.projectContexts?.[1]?.worktrees).toEqual([]);

    store.apply(envelope(2, { type: "worktree.status.changed", worktreeId: worktreeA, status: "ready" }));
    expect(store.current()?.projectContexts?.[0]?.worktrees[0]?.status).toBe("ready");

    store.apply(
      envelope(3, {
        type: "thread.start.requested",
        thread: { threadId: threadA, worktreeId: worktreeA, provider: "codex", status: "idle", capabilities: {} },
        cwd: "C:/alpha/a",
      }),
    );
    store.apply(
      envelope(4, {
        type: "worktree.imported",
        worktree: {
          worktreeId: worktreeB,
          projectId: projectB,
          path: "C:/beta/b",
          branch: "feature-b",
          status: "ready",
        },
      }),
    );
    store.apply(
      envelope(5, {
        type: "thread.start.requested",
        thread: {
          threadId: threadB,
          worktreeId: worktreeB,
          provider: "cursor-agent",
          status: "idle",
          capabilities: {},
        },
        cwd: "C:/beta/b",
      }),
    );
    expect(store.current()?.projectContexts?.[0]?.threads).toEqual([
      { threadId: threadA, worktreeId: worktreeA, provider: "codex", status: "idle" },
    ]);
    expect(store.current()?.projectContexts?.[1]?.threads).toEqual([
      { threadId: threadB, worktreeId: worktreeB, provider: "cursor-agent", status: "idle" },
    ]);

    store.apply(envelope(6, { type: "thread.status.changed", threadId: threadA, status: "working" }));
    expect(store.current()?.projectContexts?.[0]?.threads[0]?.status).toBe("working");
    expect(store.current()?.projectContexts?.[1]?.threads[0]?.status).toBe("idle");

    store.apply(
      envelope(7, {
        type: "thread.a2a.delivered",
        projectId: projectA,
        message: {
          messageId: "agent-1",
          threadId: threadB,
          role: "agent",
          text: "SECRET_TRANSCRIPT_TEXT",
          sourceThreadId: threadA,
        },
      }),
    );
    expect(store.current()?.messages?.[0]?.text).toBe("SECRET_TRANSCRIPT_TEXT");
    expect(JSON.stringify(store.current()?.projectContexts)).not.toContain("SECRET_TRANSCRIPT_TEXT");
    expect(store.current()?.projectContexts?.[0]?.threads.map((thread) => thread.threadId)).toEqual([threadA]);
  });
});
