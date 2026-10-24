import { describe, expect, it } from "vitest";

import type { GitHubIssues } from "./GitHubIssues.js";
import { IssueError, runIssueCommand } from "./IssueService.js";

const PROJECT = "00000000-0000-4000-8000-000000000010" as never;
const projection = { projects: [{ projectId: PROJECT, path: "/repo", name: "repo" }] };

describe("runIssueCommand", () => {
  it("runs GitHub commands in the project folder", async () => {
    const seen: unknown[] = [];
    const github = {
      list: async (cwd: string, filter: unknown) => {
        seen.push([cwd, filter]);
        return { issues: [] };
      },
      get: async () => ({ key: "1" }),
    } as unknown as GitHubIssues;
    await runIssueCommand({ github }, projection, {
      type: "issues.list",
      projectId: PROJECT,
      source: "github",
      query: "x",
      state: "all",
    });
    expect(seen).toEqual([["/repo", { query: "x", state: "all" }]]);
    expect(
      await runIssueCommand({ github }, projection, {
        type: "issues.get",
        projectId: PROJECT,
        source: "github",
        key: "1",
      }),
    ).toEqual({ issue: { key: "1" } });
  });

  it("explains a missing project or Linear", async () => {
    const github = {} as GitHubIssues;
    await expect(
      runIssueCommand({ github }, { projects: [] }, { type: "issues.list", projectId: PROJECT, source: "github" }),
    ).rejects.toThrow(IssueError);
    await expect(
      runIssueCommand({ github }, projection, { type: "issues.list", projectId: PROJECT, source: "linear" }),
    ).rejects.toThrow(/not available/u);
    expect(await runIssueCommand({ github }, projection, { type: "issues.linear.status" })).toMatchObject({
      connected: false,
    });
  });
});
