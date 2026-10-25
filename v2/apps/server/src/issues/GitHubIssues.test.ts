import { describe, expect, it } from "vitest";

import type { ProcessResult, ProcessRunner } from "../review/PullRequestService.js";
import { GitHubIssues, parseGitHubIssue, parseGitHubIssueList } from "./GitHubIssues.js";
import { IssueError } from "./issueText.js";

type Call = { command: "git" | "gh"; args: string[]; cwd: string };

const ok = (stdout = ""): ProcessResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): ProcessResult => ({ code, stdout: "", stderr });

const RAW_ISSUE = {
  number: 42,
  title: "Login button does nothing",
  state: "OPEN",
  url: "https://github.com/acme/app/issues/42",
  updatedAt: "2026-01-02T03:04:05Z",
  author: { login: "octo", name: "Octo Cat", is_bot: false },
  assignees: [{ login: "alice", name: "Alice" }],
  labels: [{ id: "L1", name: "bug", color: "d73a4a", description: "" }],
  comments: [
    { author: { login: "bob" }, body: "Seen on Safari too.", createdAt: "2026-01-02T00:00:00Z" },
    { author: { login: "carol" }, body: "Probably the click handler.", createdAt: "2026-01-03T00:00:00Z" },
  ],
  body: "Clicking **Log in** does nothing.",
};

function fakeRunner(overrides: (call: Call) => ProcessResult | Error | undefined = () => undefined) {
  const calls: Call[] = [];
  const runner: ProcessRunner = async (command, args, options) => {
    const call = { command, args: [...args], cwd: options.cwd };
    calls.push(call);
    const override = overrides(call);
    if (override instanceof Error) throw override;
    if (override) return override;
    const line = `${command} ${args.join(" ")}`;
    if (line === "git remote") return ok("origin\n");
    if (line === "gh --version") return ok("gh version 2.60.0\n");
    if (line === "gh auth status") return ok();
    if (line.startsWith("gh issue list")) return ok(JSON.stringify([RAW_ISSUE]));
    if (line.startsWith("gh issue view 42")) return ok(JSON.stringify(RAW_ISSUE));
    if (line.startsWith("gh issue view"))
      return fail("GraphQL: Could not resolve to an issue or pull request with the number of 7.");
    return fail(`unexpected: ${line}`, 2);
  };
  return { runner, calls };
}

describe("parseGitHubIssueList", () => {
  it("reads gh issue list JSON into rows", () => {
    expect(parseGitHubIssueList(JSON.stringify([RAW_ISSUE, { title: "no number" }]))).toEqual([
      {
        source: "github",
        key: "42",
        reference: "#42",
        title: "Login button does nothing",
        state: "open",
        stateName: "Open",
        url: "https://github.com/acme/app/issues/42",
        labels: [{ name: "bug", color: "d73a4a" }],
        assignees: ["alice"],
        author: "octo",
        updatedAt: "2026-01-02T03:04:05Z",
        commentCount: 2,
      },
    ]);
  });

  it("rejects output that is not a list", () => {
    expect(() => parseGitHubIssueList("{}")).toThrow(IssueError);
    expect(() => parseGitHubIssueList("not json")).toThrow(IssueError);
  });
});

describe("parseGitHubIssue", () => {
  it("keeps the body and comments, oldest first", () => {
    const issue = parseGitHubIssue(JSON.stringify({ ...RAW_ISSUE, state: "CLOSED" }));
    expect(issue?.state).toBe("closed");
    expect(issue?.body).toBe("Clicking **Log in** does nothing.");
    expect(issue?.comments).toEqual([
      { author: "bob", body: "Seen on Safari too.", createdAt: "2026-01-02T00:00:00Z" },
      { author: "carol", body: "Probably the click handler.", createdAt: "2026-01-03T00:00:00Z" },
    ]);
  });

  it("keeps only the latest 30 comments", () => {
    const comments = Array.from({ length: 40 }, (_, index) => ({ author: { login: "a" }, body: `c${index}` }));
    const issue = parseGitHubIssue(JSON.stringify({ ...RAW_ISSUE, comments }));
    expect(issue?.comments).toHaveLength(30);
    expect(issue?.comments[0]?.body).toBe("c10");
    expect(issue?.commentCount).toBe(40);
  });
});

describe("GitHubIssues", () => {
  it("lists open issues by default and passes the filters to gh", async () => {
    const { runner, calls } = fakeRunner();
    const issues = new GitHubIssues(runner);
    const result = await issues.list("/repo", { assignee: "me", labels: ["bug"], query: "login" });
    expect(result.issues.map((issue) => issue.reference)).toEqual(["#42"]);
    const list = calls.find((call) => call.args[1] === "list");
    expect(list?.cwd).toBe("/repo");
    expect(list?.args).toEqual([
      "issue",
      "list",
      "--json",
      "number,title,state,labels,assignees,author,updatedAt,url,comments",
      "--limit",
      "50",
      "--state",
      "open",
      "--assignee",
      "@me",
      "--label",
      "bug",
      "--search",
      "login",
    ]);
  });

  it("looks a number up directly", async () => {
    const { runner, calls } = fakeRunner();
    const result = await new GitHubIssues(runner).list("/repo", { query: "#42" });
    expect(result.issues).toHaveLength(1);
    expect(calls.some((call) => call.args[1] === "list")).toBe(false);
  });

  it("falls back to a search when the number is not an issue", async () => {
    const { runner, calls } = fakeRunner();
    await new GitHubIssues(runner).list("/repo", { query: "7" });
    expect(calls.some((call) => call.args[1] === "list")).toBe(true);
  });

  it("reads one issue with its body and comments", async () => {
    const { runner, calls } = fakeRunner();
    const issue = await new GitHubIssues(runner).get("/repo", "42");
    expect(issue.body).toContain("Log in");
    expect(calls.at(-1)?.args).toEqual([
      "issue",
      "view",
      "42",
      "--json",
      "number,title,state,labels,assignees,author,updatedAt,url,comments,body",
    ]);
  });

  it("says when an issue does not exist", async () => {
    const { runner } = fakeRunner();
    await expect(new GitHubIssues(runner).get("/repo", "7")).rejects.toThrow("Issue #7 was not found");
  });

  it("explains a missing GitHub CLI", async () => {
    const { runner } = fakeRunner((call) =>
      call.command === "gh" ? Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) : undefined,
    );
    await expect(new GitHubIssues(runner).list("/repo", {})).rejects.toThrow(/not installed/u);
  });

  it("explains a signed out GitHub CLI", async () => {
    const { runner } = fakeRunner((call) => (call.args[0] === "auth" ? fail("not logged in") : undefined));
    await expect(new GitHubIssues(runner).list("/repo", {})).rejects.toThrow(/gh auth login/u);
  });

  it("explains a folder without a remote", async () => {
    const { runner, calls } = fakeRunner((call) => (call.command === "git" ? ok("") : undefined));
    await expect(new GitHubIssues(runner).list("/repo", {})).rejects.toThrow(/no Git remote/u);
    expect(calls.some((call) => call.command === "gh")).toBe(false);
  });

  it("explains remotes that are not on GitHub", async () => {
    const { runner } = fakeRunner((call) =>
      call.args[1] === "list"
        ? fail("none of the git remotes configured for this repository point to a known GitHub host.")
        : undefined,
    );
    await expect(new GitHubIssues(runner).list("/repo", {})).rejects.toThrow(/point to a GitHub repository/u);
  });

  it("redacts tokens from other gh failures", async () => {
    const { runner } = fakeRunner((call) =>
      call.args[1] === "list" ? fail("HTTP 502 for https://user:ghp_abcdefghijklmnop@github.com") : undefined,
    );
    const error = await new GitHubIssues(runner).list("/repo", {}).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(IssueError);
    expect(String((error as Error).message)).not.toContain("ghp_abcdefghijklmnop");
  });

  it("checks the GitHub CLI once for a while", async () => {
    const { runner, calls } = fakeRunner();
    const issues = new GitHubIssues(runner);
    await issues.list("/repo", {});
    await issues.list("/repo", {});
    expect(calls.filter((call) => call.args[0] === "auth")).toHaveLength(1);
  });
});
