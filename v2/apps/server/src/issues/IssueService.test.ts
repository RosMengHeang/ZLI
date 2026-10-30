import { describe, expect, it } from "vitest";

import type { GitHubIssues } from "./GitHubIssues.js";
import type { GitLabIssues } from "./GitLabIssues.js";
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

  it("runs GitLab commands in the project folder", async () => {
    const seen: unknown[] = [];
    const gitlab = {
      list: async (cwd: string, filter: unknown) => {
        seen.push([cwd, filter]);
        return { issues: [] };
      },
      get: async (cwd: string, key: string) => ({ cwd, key }),
    } as unknown as GitLabIssues;
    const github = {} as GitHubIssues;
    await runIssueCommand({ github, gitlab }, projection, {
      type: "issues.list",
      projectId: PROJECT,
      source: "gitlab",
      assignee: "me",
    });
    expect(seen).toEqual([["/repo", { assignee: "me" }]]);
    expect(
      await runIssueCommand({ github, gitlab }, projection, {
        type: "issues.get",
        projectId: PROJECT,
        source: "gitlab",
        key: "12",
      }),
    ).toEqual({ issue: { cwd: "/repo", key: "12" } });
    await expect(
      runIssueCommand({ github }, projection, { type: "issues.list", projectId: PROJECT, source: "gitlab" }),
    ).rejects.toThrow(/GitLab is not available/u);
  });

  it("says which sources the project's remotes point to", async () => {
    const github = {} as GitHubIssues;
    const gitlab = {} as GitLabIssues;
    const command = { type: "issues.sources", projectId: PROJECT } as const;
    const remotes = async (cwd: string) => {
      expect(cwd).toBe("/repo");
      return { sources: ["gitlab", "github"] as ("github" | "gitlab")[], hosts: {} };
    };
    expect(await runIssueCommand({ github, gitlab, remotes }, projection, command)).toEqual({
      sources: ["gitlab", "github"],
    });
    expect(await runIssueCommand({ github, remotes }, projection, command)).toEqual({ sources: ["github"] });
    const elsewhere = async () => ({ unavailable: { code: "other_host" as const, host: "bitbucket.org" } });
    expect(await runIssueCommand({ github, gitlab, remotes: elsewhere }, projection, command)).toEqual({
      sources: [],
      unavailable: { code: "other_host", host: "bitbucket.org" },
    });
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
