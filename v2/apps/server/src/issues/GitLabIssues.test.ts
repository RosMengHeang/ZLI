import { describe, expect, it } from "vitest";

import type { ProcessResult, ProcessRunner } from "../review/PullRequestService.js";
import { GitLabIssues, parseGitLabIssue, parseGitLabIssueList } from "./GitLabIssues.js";
import { IssueError } from "./issueText.js";

type Call = { command: Parameters<ProcessRunner>[0]; args: string[]; cwd: string };

const ok = (stdout = ""): ProcessResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): ProcessResult => ({ code, stdout: "", stderr });
const remotes = (...lines: [string, string][]) =>
  ok(lines.map(([name, url]) => `${name}\t${url} (fetch)\n${name}\t${url} (push)\n`).join(""));
const noHosts = { github: async () => [], gitlab: async () => [] };

const RAW_ISSUE = {
  id: 9001,
  iid: 12,
  project_id: 7,
  title: "Login button does nothing",
  description: "Clicking **Log in** does nothing.",
  state: "opened",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T03:04:05.000Z",
  labels: ["bug", "frontend"],
  assignees: [{ id: 1, username: "alice", name: "Alice" }],
  assignee: { id: 1, username: "alice", name: "Alice" },
  author: { id: 2, username: "octo", name: "Octo Cat" },
  user_notes_count: 2,
  web_url: "https://gitlab.company.com/acme/app/-/issues/12",
  references: { short: "#12", relative: "#12", full: "acme/app#12" },
};
const NOTES = [
  {
    body: "Probably the click handler.",
    author: { username: "carol" },
    created_at: "2026-01-03T00:00:00Z",
    system: false,
  },
  { body: "added ~bug label", author: { username: "octo" }, created_at: "2026-01-02T12:00:00Z", system: true },
  { body: "Seen on Safari too.", author: { username: "bob" }, created_at: "2026-01-02T00:00:00Z", system: false },
];

function fakeRunner(overrides: (call: Call) => ProcessResult | Error | undefined = () => undefined) {
  const calls: Call[] = [];
  const runner: ProcessRunner = async (command, args, options) => {
    const call = { command, args: [...args], cwd: options.cwd };
    calls.push(call);
    const override = overrides(call);
    if (override instanceof Error) throw override;
    if (override) return override;
    const line = `${command} ${args.join(" ")}`;
    if (line === "git remote -v") return remotes(["origin", "git@gitlab.company.com:acme/app.git"]);
    if (line === "glab --version") return ok("glab 1.50.0 (2025-01-01)\n");
    if (line === "glab auth status --hostname gitlab.company.com") return ok();
    if (line.startsWith("glab issue list")) return ok(JSON.stringify([RAW_ISSUE]));
    if (line.startsWith("glab issue view 12")) return ok(JSON.stringify({ ...RAW_ISSUE, Notes: NOTES }));
    if (line.startsWith("glab issue view")) return fail("ERROR: 404 Not Found.");
    return fail(`unexpected: ${line}`, 2);
  };
  return { runner, calls };
}

describe("parseGitLabIssueList", () => {
  it("reads glab issue list JSON into rows", () => {
    expect(parseGitLabIssueList(JSON.stringify([RAW_ISSUE, { title: "no iid" }]))).toEqual([
      {
        source: "gitlab",
        key: "12",
        reference: "#12",
        title: "Login button does nothing",
        state: "open",
        stateName: "Open",
        url: "https://gitlab.company.com/acme/app/-/issues/12",
        labels: [{ name: "bug" }, { name: "frontend" }],
        assignees: ["alice"],
        author: "octo",
        updatedAt: "2026-01-02T03:04:05.000Z",
        commentCount: 2,
      },
    ]);
  });

  it("reads an empty answer as no issues and rejects anything else", () => {
    expect(parseGitLabIssueList("")).toEqual([]);
    expect(parseGitLabIssueList("[]")).toEqual([]);
    expect(() => parseGitLabIssueList("{}")).toThrow(IssueError);
    expect(() => parseGitLabIssueList("not json")).toThrow(IssueError);
  });

  it("reads label details and a single assignee", () => {
    const { assignees: _assignees, ...rest } = RAW_ISSUE;
    const [row] = parseGitLabIssueList(
      JSON.stringify([{ ...rest, state: "closed", labels: [{ name: "bug", color: "#d73a4a" }] }]),
    );
    expect(row).toMatchObject({ state: "closed", labels: [{ name: "bug", color: "#d73a4a" }], assignees: ["alice"] });
  });
});

describe("parseGitLabIssue", () => {
  it("keeps the description and the comments people wrote, oldest first", () => {
    const issue = parseGitLabIssue(JSON.stringify({ ...RAW_ISSUE, notes: NOTES }));
    expect(issue?.body).toBe("Clicking **Log in** does nothing.");
    expect(issue?.comments).toEqual([
      { author: "bob", body: "Seen on Safari too.", createdAt: "2026-01-02T00:00:00Z" },
      { author: "carol", body: "Probably the click handler.", createdAt: "2026-01-03T00:00:00Z" },
    ]);
  });

  it("is undefined for output that is not an issue", () => {
    expect(parseGitLabIssue("{}")).toBeUndefined();
    expect(parseGitLabIssue("oops")).toBeUndefined();
  });
});

describe("GitLabIssues", () => {
  it("lists open issues by default and passes the filters to glab", async () => {
    const { runner, calls } = fakeRunner();
    const result = await new GitLabIssues(runner, noHosts).list("/repo", {
      assignee: "me",
      labels: ["bug"],
      query: "login",
    });
    expect(result.issues.map((issue) => issue.reference)).toEqual(["#12"]);
    const list = calls.find((call) => call.args[1] === "list");
    expect(list?.cwd).toBe("/repo");
    expect(list?.args).toEqual([
      "issue",
      "list",
      "--output",
      "json",
      "--per-page",
      "50",
      "--assignee=@me",
      "--label=bug",
      "--search=login",
    ]);
  });

  it("asks for closed or all issues", async () => {
    const { runner, calls } = fakeRunner();
    const issues = new GitLabIssues(runner, noHosts);
    await issues.list("/repo", { state: "closed" });
    await issues.list("/repo", { state: "all" });
    const lists = calls.filter((call) => call.args[1] === "list").map((call) => call.args.slice(6));
    expect(lists).toEqual([["--closed"], ["--all"]]);
  });

  it("looks a number up directly and falls back to a search", async () => {
    const { runner, calls } = fakeRunner();
    const issues = new GitLabIssues(runner, noHosts);
    expect((await issues.list("/repo", { query: "#12" })).issues).toHaveLength(1);
    expect(calls.some((call) => call.args[1] === "list")).toBe(false);
    await issues.list("/repo", { query: "7" });
    expect(calls.some((call) => call.args[1] === "list")).toBe(true);
  });

  it("reads one issue with its comments", async () => {
    const { runner, calls } = fakeRunner();
    const issue = await new GitLabIssues(runner, noHosts).get("/repo", "12");
    expect(issue.comments).toHaveLength(2);
    expect(calls.at(-1)?.args).toEqual(["issue", "view", "12", "--comments", "--per-page", "100", "--output", "json"]);
  });

  it("says when an issue does not exist", async () => {
    const { runner } = fakeRunner();
    await expect(new GitLabIssues(runner, noHosts).get("/repo", "7")).rejects.toThrow("Issue #7 was not found");
  });

  it("explains a missing GitLab CLI", async () => {
    const { runner } = fakeRunner((call) =>
      call.command === "glab" ? Object.assign(new Error("spawn glab ENOENT"), { code: "ENOENT" }) : undefined,
    );
    await expect(new GitLabIssues(runner, noHosts).list("/repo", {})).rejects.toThrow(
      /GitLab CLI \(glab\) is not installed/u,
    );
  });

  it("names the command that signs glab in to the project's host", async () => {
    const { runner } = fakeRunner((call) =>
      call.args[0] === "auth" ? fail("x gitlab.company.com: no token found") : undefined,
    );
    await expect(new GitLabIssues(runner, noHosts).list("/repo", {})).rejects.toThrow(
      "Run glab auth login --hostname gitlab.company.com in a terminal",
    );
  });

  it("checks the GitLab CLI once for a while per host", async () => {
    const { runner, calls } = fakeRunner();
    const issues = new GitLabIssues(runner, noHosts);
    await issues.list("/repo", {});
    await issues.list("/repo", {});
    expect(calls.filter((call) => call.args[0] === "auth")).toHaveLength(1);
  });

  it("lists nothing for a project on neither GitHub nor GitLab, without running glab", async () => {
    const { runner, calls } = fakeRunner((call) =>
      call.command === "git" ? remotes(["origin", "git@bitbucket.org:acme/app.git"]) : undefined,
    );
    expect(await new GitLabIssues(runner, noHosts).list("/repo", {})).toEqual({
      issues: [],
      unavailable: { code: "other_host", host: "bitbucket.org" },
    });
    expect(calls.some((call) => call.command === "glab")).toBe(false);
  });

  it("refuses a project on GitHub", async () => {
    const { runner } = fakeRunner((call) =>
      call.command === "git" ? remotes(["origin", "git@github.com:acme/app.git"]) : undefined,
    );
    await expect(new GitLabIssues(runner, noHosts).list("/repo", {})).rejects.toThrow(/not GitLab/u);
  });

  it("explains failures and redacts tokens", async () => {
    const failing = (stderr: string) =>
      fakeRunner((call) => (call.args[1] === "list" ? fail(stderr) : undefined)).runner;
    await expect(new GitLabIssues(failing("ERROR: 401 Unauthorized"), noHosts).list("/repo", {})).rejects.toThrow(
      /glab auth login --hostname gitlab\.company\.com/u,
    );
    await expect(new GitLabIssues(failing("ERROR: 404 Project Not Found"), noHosts).list("/repo", {})).rejects.toThrow(
      /no project at this folder's remote/u,
    );
    // Built at runtime so the obviously fake token never sits in the source as a token-shaped literal.
    const token = ["glpat", "x".repeat(20)].join("-");
    const error = await new GitLabIssues(failing(`HTTP 502 with ${token}`), noHosts)
      .list("/repo", {})
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(IssueError);
    expect(String((error as Error).message)).toMatch(/^GitLab CLI could not read the issues/u);
    expect(String((error as Error).message)).not.toContain(token);
  });
});
