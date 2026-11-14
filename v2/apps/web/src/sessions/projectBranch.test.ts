import type { RpcResponse } from "@zli-v2/contracts";
import { describe, expect, it, vi } from "vitest";

import { readProjectBranch } from "./projectBranch.js";

const answer = (response: Record<string, unknown> | undefined) =>
  vi.fn(async (request: unknown) =>
    response ? ({ ...response, commandId: (request as { commandId: string }).commandId } as RpcResponse) : undefined,
  );

describe("readProjectBranch", () => {
  it("asks for the project's branch and returns what git said", async () => {
    const dispatch = answer({ accepted: true, result: { git: true, branch: "main" } });
    expect(await readProjectBranch(dispatch, "project-1")).toEqual({ git: true, branch: "main" });
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      protocolVersion: 1,
      command: { type: "project.branch", projectId: "project-1" },
    });
  });

  it("passes on a folder that is not a Git repository", async () => {
    const dispatch = answer({ accepted: true, result: { git: false } });
    expect(await readProjectBranch(dispatch, "project-1")).toEqual({ git: false });
  });

  it("returns nothing when the runtime refuses, answers oddly, or is gone", async () => {
    const refused = answer({
      accepted: false,
      error: { code: "invalid_request", message: "Project does not exist.", retryable: false },
    });
    expect(await readProjectBranch(refused, "project-1")).toBeUndefined();
    expect(await readProjectBranch(answer({ accepted: true, result: { branch: 3 } }), "project-1")).toBeUndefined();
    expect(await readProjectBranch(answer(undefined), "project-1")).toBeUndefined();
    const thrown = vi.fn(async () => {
      throw new Error("closed");
    });
    expect(await readProjectBranch(thrown, "project-1")).toBeUndefined();
  });
});
