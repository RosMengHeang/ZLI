import type { RpcResponse, RuntimeProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { ids, sampleProjection } from "./fixtures.js";
import { launchAgent, sendCommand } from "./launch.js";
import type { LinkSnapshot } from "./link.js";

function fakeLink(projection: RuntimeProjection, answer: (command: { type: string }) => RpcResponse | Error) {
  const listeners = new Set<() => void>();
  let snapshot = { projection } as LinkSnapshot;
  const sent: { type: string }[] = [];
  return {
    sent,
    link: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      command: async (command: { type: string }) => {
        sent.push(command);
        const response = answer(command);
        if (response instanceof Error) throw response;
        return response;
      },
    },
    publish(next: RuntimeProjection) {
      snapshot = { projection: next } as LinkSnapshot;
      for (const listener of listeners) listener();
    },
  };
}

const commandId = "8b9c0d1e-2f3a-4b8c-9d9e-0f1a2b3c4d5e" as RpcResponse["commandId"];
const accepted: RpcResponse = { commandId, accepted: true };

describe("sendCommand", () => {
  it("reports a refusal and a dropped connection as messages", async () => {
    const refused = fakeLink(sampleProjection(), () => ({
      commandId,
      accepted: false,
      error: { code: "invalid_request", message: "Phones cannot send that.", retryable: false },
    }));
    await expect(sendCommand(refused.link, { type: "thread.stop" }, "fallback")).resolves.toEqual({
      ok: false,
      error: "Phones cannot send that.",
    });
    const dropped = fakeLink(sampleProjection(), () => new Error(""));
    await expect(sendCommand(dropped.link, { type: "thread.stop" }, "fallback")).resolves.toEqual({
      ok: false,
      error: "fallback",
    });
  });
});

describe("launchAgent", () => {
  it("creates the worktree, waits for it, then starts the agent in it", async () => {
    const projection = sampleProjection();
    const fake = fakeLink(projection, () => accepted);
    const steps: string[] = [];
    let counter = 0;
    const newId = () => {
      counter += 1;
      return `id-${counter}`;
    };
    const project = projection.projects[0];
    if (!project) throw new Error("fixture has a project");
    const launched = launchAgent(
      fake.link,
      {
        project,
        placement: { kind: "new", branch: "docs" },
        provider: "codex",
        model: "o4",
        permissionMode: "full-access",
      },
      newId,
      (step) => steps.push(step),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.sent.map((command) => command.type)).toEqual(["worktree.create"]);
    fake.publish({
      ...projection,
      worktrees: [
        ...projection.worktrees,
        {
          worktreeId: "id-1" as RuntimeProjection["worktrees"][number]["worktreeId"],
          projectId: project.projectId,
          path: "/home/dev/app-worktrees/docs",
          branch: "docs",
          status: "ready",
        },
      ],
    });
    await expect(launched).resolves.toEqual({ threadId: "id-2" });
    expect(steps).toEqual(["creating-worktree", "starting-agent"]);
    expect(fake.sent[1]).toMatchObject({
      type: "thread.start",
      worktreeId: "id-1",
      cwd: "/home/dev/app-worktrees/docs",
      model: "o4",
    });
  });

  it("stops when the worktree fails or the person stops waiting", async () => {
    const projection = sampleProjection();
    const project = projection.projects[0];
    if (!project) throw new Error("fixture has a project");
    const failing = fakeLink(
      {
        ...projection,
        worktrees: projection.worktrees.map((worktree) =>
          worktree.worktreeId === ids.feature
            ? { ...worktree, status: "failed", errorMessage: "Branch exists" }
            : worktree,
        ),
      },
      () => accepted,
    );
    const input = { project, provider: "codex", model: undefined, permissionMode: "full-access" } as const;
    await expect(
      launchAgent(
        failing.link,
        { ...input, placement: { kind: "existing", worktreeId: ids.feature } },
        () => "x",
        () => {},
      ),
    ).resolves.toEqual({ error: "Branch exists" });

    const controller = new AbortController();
    const waiting = launchAgent(
      fakeLink(projection, () => accepted).link,
      { ...input, placement: { kind: "existing", worktreeId: "missing" } },
      () => "x",
      () => {},
      controller.signal,
    );
    controller.abort();
    await expect(waiting).resolves.toEqual({ error: "Stopped waiting for the worktree." });
    expect(failing.sent).toEqual([]);
  });

  it("asks for a branch name before creating anything", async () => {
    const projection = sampleProjection();
    const project = projection.projects[0];
    if (!project) throw new Error("fixture has a project");
    const fake = fakeLink(projection, () => accepted);
    await expect(
      launchAgent(
        fake.link,
        {
          project,
          placement: { kind: "new", branch: " / " },
          provider: "codex",
          model: undefined,
          permissionMode: "full-access",
        },
        () => "x",
        () => {},
      ),
    ).resolves.toEqual({ error: "Choose a branch name for the new worktree." });
    expect(fake.sent).toEqual([]);
  });
});
