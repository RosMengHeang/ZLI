import { describe, expect, it } from "vitest";

import {
  actionsJob,
  failedLogExcerpt,
  formatBody,
  hunkTail,
  parsePullRequestLink,
  parseReviewComments,
  type ProcessResult,
  type ProcessRunner,
  PullRequestError,
  PullRequestService,
  redactSecrets,
  summarizeChecks,
} from "./PullRequestService.js";

type Call = { command: "git" | "gh"; args: string[]; cwd: string };
type Handler = (call: Call) => ProcessResult | Error | undefined;

const ok = (stdout = ""): ProcessResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): ProcessResult => ({ code, stdout: "", stderr });
const INPUT = { worktreePath: "/repo/feature", fallbackBase: "main" };
const PR_JSON = JSON.stringify({
  number: 12,
  url: "https://github.com/acme/app/pull/12",
  state: "OPEN",
  isDraft: true,
});

/** A happy repository: branch feature/pr, clean, origin with main as default, two commits ahead, gh signed in. */
function fakeRunner(overrides: Handler = () => undefined): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: ProcessRunner = async (command, args, options) => {
    const call = { command, args: [...args], cwd: options.cwd };
    calls.push(call);
    const override = overrides(call);
    if (override instanceof Error) throw override;
    if (override) return override;
    const line = `${command} ${args.join(" ")}`;
    if (line === "git rev-parse --abbrev-ref HEAD") return ok("feature/pr\n");
    if (line === "git status --porcelain=v1") return ok("");
    if (line === "git remote get-url origin") return ok("https://user:secret@example.com/acme/app.git\n");
    if (line.startsWith("git symbolic-ref")) return ok("origin/main\n");
    if (line === "git rev-parse --verify --quiet refs/remotes/origin/main") return ok("abc\n");
    if (line.startsWith("git log --reverse")) return ok("Add the button\nWire the dialog\n");
    if (line.startsWith("git push")) return ok();
    if (line === "gh --version") return ok("gh version 2.60.0\n");
    if (line === "gh auth status") return ok();
    if (line.startsWith("gh pr view")) return fail('no pull requests found for branch "feature/pr"');
    if (line.startsWith("gh pr create")) return ok("https://github.com/acme/app/pull/12\n");
    return fail(`unexpected: ${line}`, 2);
  };
  return { runner, calls };
}

function missing(): Error {
  return Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
}

describe("PullRequestService.status", () => {
  it("offers defaults from the commits since the origin default branch", async () => {
    const { runner } = fakeRunner();
    const status = await new PullRequestService(runner).status(INPUT);
    expect(status).toEqual({
      branch: "feature/pr",
      uncommittedFiles: 0,
      commitsAhead: 2,
      defaults: { title: "Wire the dialog", body: "- Add the button\n- Wire the dialog", base: "main" },
    });
  });

  it("reports an existing pull request for the branch", async () => {
    const { runner, calls } = fakeRunner(({ command, args }) =>
      command === "gh" && args[0] === "pr" ? ok(PR_JSON) : undefined,
    );
    const status = await new PullRequestService(runner).status(INPUT);
    expect(status.pullRequest).toEqual({
      number: 12,
      url: "https://github.com/acme/app/pull/12",
      state: "OPEN",
      isDraft: true,
    });
    expect(calls.at(-1)?.args).toEqual([
      "pr",
      "view",
      "feature/pr",
      "--json",
      "url,state,isDraft,number,statusCheckRollup,reviewDecision",
    ]);
  });

  it("reports checks and the review decision of the pull request", async () => {
    const view = JSON.stringify({
      ...JSON.parse(PR_JSON),
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          name: "test",
          workflowName: "CI",
          status: "COMPLETED",
          conclusion: "FAILURE",
          detailsUrl: "https://github.com/acme/app/actions/runs/5/job/9",
        },
        { __typename: "StatusContext", context: "deploy/preview", state: "PENDING", targetUrl: "https://ci.example/1" },
      ],
    });
    const { runner } = fakeRunner(({ command, args }) => (command === "gh" && args[0] === "pr" ? ok(view) : undefined));
    const status = await new PullRequestService(runner).status(INPUT);
    expect(status.pullRequest?.reviewDecision).toBe("CHANGES_REQUESTED");
    expect(status.pullRequest?.checks).toEqual([
      { name: "test", workflow: "CI", state: "failed", url: "https://github.com/acme/app/actions/runs/5/job/9" },
      { name: "deploy/preview", state: "pending", url: "https://ci.example/1" },
    ]);
  });

  it("asks GitHub CLI whether it is signed in only once in a while", async () => {
    const { runner, calls } = fakeRunner();
    const service = new PullRequestService(runner);
    await service.status(INPUT);
    await service.status(INPUT);
    expect(calls.filter((call) => call.args.join(" ") === "auth status")).toHaveLength(1);
  });

  it("uses the requested base and falls back to the local branch when origin lacks it", async () => {
    const { runner, calls } = fakeRunner(({ args }) => {
      if (args.join(" ") === "rev-parse --verify --quiet refs/remotes/origin/release") return fail("");
      if (args.join(" ") === "rev-parse --verify --quiet refs/heads/release") return ok("def\n");
      return undefined;
    });
    const status = await new PullRequestService(runner).status(INPUT, "release");
    expect(status.defaults.base).toBe("release");
    expect(calls.some((call) => call.args.join(" ") === "log --reverse --format=%s refs/heads/release..HEAD")).toBe(
      true,
    );
  });

  it("explains that gh is missing", async () => {
    const { runner } = fakeRunner(({ command }) => (command === "gh" ? missing() : undefined));
    const status = await new PullRequestService(runner).status(INPUT);
    expect(status.problem?.code).toBe("gh_missing");
    expect(status.problem?.message).toContain("https://cli.github.com");
    expect(status.defaults.title).toBe("Wire the dialog");
  });

  it("explains that gh is not signed in", async () => {
    const { runner } = fakeRunner(({ args }) =>
      args.join(" ") === "auth status" ? fail("You are not logged into any GitHub hosts.") : undefined,
    );
    expect((await new PullRequestService(runner).status(INPUT)).problem).toMatchObject({ code: "gh_unauthenticated" });
  });

  it("explains a missing origin without printing remote URLs", async () => {
    const { runner } = fakeRunner(({ args }) =>
      args.join(" ") === "remote get-url origin" ? fail("error: No such remote 'origin'", 2) : undefined,
    );
    const status = await new PullRequestService(runner).status(INPUT);
    expect(status.problem?.code).toBe("no_origin");
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("explains a detached worktree", async () => {
    const { runner } = fakeRunner(({ args }) =>
      args.join(" ") === "rev-parse --abbrev-ref HEAD" ? ok("HEAD\n") : undefined,
    );
    const status = await new PullRequestService(runner).status(INPUT);
    expect(status).toMatchObject({ branch: "HEAD", problem: { code: "detached" } });
  });

  it("counts uncommitted files", async () => {
    const { runner } = fakeRunner(({ args }) =>
      args[0] === "status" ? ok(" M src/app.ts\n?? notes.md\n") : undefined,
    );
    expect((await new PullRequestService(runner).status(INPUT)).uncommittedFiles).toBe(2);
  });
});

describe("PullRequestService.push", () => {
  it("pushes the branch to origin with upstream tracking", async () => {
    const { runner, calls } = fakeRunner();
    await expect(new PullRequestService(runner).push(INPUT)).resolves.toEqual({
      branch: "feature/pr",
      remote: "origin",
    });
    expect(calls.at(-1)).toEqual({
      command: "git",
      args: ["push", "-u", "origin", "feature/pr"],
      cwd: "/repo/feature",
    });
  });

  it("refuses to push with uncommitted changes", async () => {
    const { runner, calls } = fakeRunner(({ args }) => (args[0] === "status" ? ok(" M src/app.ts\n") : undefined));
    await expect(new PullRequestService(runner).push(INPUT)).rejects.toThrow(
      "1 file has uncommitted changes. Commit them first",
    );
    expect(calls.some((call) => call.args[0] === "push")).toBe(false);
  });

  it("explains a rejected push", async () => {
    const { runner } = fakeRunner(({ args }) =>
      args[0] === "push"
        ? fail(" ! [rejected]        feature/pr -> feature/pr (fetch first)\nerror: failed to push some refs")
        : undefined,
    );
    await expect(new PullRequestService(runner).push(INPUT)).rejects.toThrow("origin rejected the push of feature/pr");
  });

  it("does not leak credentials from a failed push", async () => {
    const { runner } = fakeRunner(({ args }) =>
      args[0] === "push"
        ? fail(
            "fatal: unable to access 'https://x-access-token:ghs_abcdefghijklmnop@github.com/acme/app.git/': timeout",
          )
        : undefined,
    );
    const error = await new PullRequestService(runner).push(INPUT).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PullRequestError);
    expect((error as Error).message).not.toContain("ghs_abcdefghijklmnop");
    expect((error as Error).message).toContain("Pushing feature/pr to origin failed.");
  });

  it("explains a missing origin", async () => {
    const { runner } = fakeRunner(({ args }) => (args[0] === "remote" ? fail("error: No such remote", 2) : undefined));
    await expect(new PullRequestService(runner).push(INPUT)).rejects.toThrow("no origin remote");
  });
});

describe("PullRequestService.create", () => {
  const request = { title: "Wire the dialog", body: "- Add the button", base: "main", draft: true };

  it("creates a draft pull request with arguments, not a shell line", async () => {
    let created = false;
    const { runner, calls } = fakeRunner(({ args }) => {
      if (args[0] === "pr" && args[1] === "create") created = true;
      if (args[0] === "pr" && args[1] === "view" && created) return ok(PR_JSON);
      return undefined;
    });
    const result = await new PullRequestService(runner).create(INPUT, request);
    expect(result.pullRequest.number).toBe(12);
    const create = calls.find((call) => call.args[1] === "create");
    expect(create?.args).toEqual([
      "pr",
      "create",
      "--head",
      "feature/pr",
      "--base",
      "main",
      "--title",
      "Wire the dialog",
      "--body",
      "- Add the button",
      "--draft",
    ]);
  });

  it("leaves out --draft for a ready pull request and reads the number from the link", async () => {
    const { runner, calls } = fakeRunner();
    const result = await new PullRequestService(runner).create(INPUT, { ...request, draft: false });
    expect(calls.find((call) => call.args[1] === "create")?.args).not.toContain("--draft");
    expect(result.pullRequest).toEqual({
      number: 12,
      url: "https://github.com/acme/app/pull/12",
      state: "OPEN",
      isDraft: false,
    });
  });

  it("returns the pull request that already exists for the branch", async () => {
    const { runner } = fakeRunner(({ args }) => {
      if (args[1] === "create")
        return fail(
          'a pull request for branch "feature/pr" into branch "main" already exists:\nhttps://github.com/acme/app/pull/12',
        );
      if (args[1] === "view") return ok(PR_JSON);
      return undefined;
    });
    await expect(new PullRequestService(runner).create(INPUT, request)).resolves.toMatchObject({
      pullRequest: { number: 12 },
    });
  });

  it("explains that gh is missing", async () => {
    const { runner } = fakeRunner(({ command }) => (command === "gh" ? missing() : undefined));
    await expect(new PullRequestService(runner).create(INPUT, request)).rejects.toThrow("is not installed");
  });

  it("rejects an unsafe base branch before running anything", async () => {
    const { runner, calls } = fakeRunner();
    await expect(new PullRequestService(runner).create(INPUT, { ...request, base: "--upload-pack=x" })).rejects.toThrow(
      "Unsafe Git ref",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("PullRequestService.checkLog", () => {
  const url = "https://github.com/acme/app/actions/runs/5/job/9";

  it("reads the failed part of a GitHub Actions job log", async () => {
    const log = [
      "test\tUNKNOWN STEP\t\uFEFF2026-01-01T00:00:00.0000000Z Current runner version: '2.338.0'",
      "test\tUNKNOWN STEP\t2026-01-01T00:00:01.0000000Z ##[group]Run pnpm test",
      "test\tUNKNOWN STEP\t2026-01-01T00:00:01.1000000Z pnpm test",
      "test\tUNKNOWN STEP\t2026-01-01T00:00:01.2000000Z ##[endgroup]",
      "test\tUNKNOWN STEP\t2026-01-01T00:00:02.0000000Z \u001b[31mFAIL\u001b[0m src/app.test.ts > adds",
      "test\tUNKNOWN STEP\t2026-01-01T00:00:03.0000000Z ##[error]Process completed with exit code 1.",
      "test\tUNKNOWN STEP\t2026-01-01T00:00:04.0000000Z Post job cleanup.",
    ].join("\n");
    const { runner, calls } = fakeRunner(({ args }) => (args[0] === "run" ? ok(log) : undefined));
    const result = await new PullRequestService(runner).checkLog(INPUT, url);
    expect(result).toEqual({
      excerpt: "Run pnpm test\npnpm test\nFAIL src/app.test.ts > adds\nerror: Process completed with exit code 1.",
      truncated: false,
    });
    expect(calls.at(-1)?.args).toEqual(["run", "view", "--repo", "acme/app", "--job", "9", "--log-failed"]);
  });

  it("explains that only GitHub Actions logs can be read", async () => {
    const { runner, calls } = fakeRunner();
    await expect(new PullRequestService(runner).checkLog(INPUT, "https://ci.example/1")).rejects.toThrow(
      "only for GitHub Actions checks",
    );
    expect(calls).toHaveLength(0);
  });

  it("explains a check that is still running", async () => {
    const { runner } = fakeRunner(({ args }) =>
      args[0] === "run" ? fail("job 9 is still in progress; logs will be available when it is complete") : undefined,
    );
    await expect(new PullRequestService(runner).checkLog(INPUT, url)).rejects.toThrow("still running");
  });
});

describe("PullRequestService.comments", () => {
  const graphql = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "T1",
                isResolved: false,
                isOutdated: false,
                path: "src/app.ts",
                line: 14,
                startLine: 12,
                comments: {
                  nodes: [
                    {
                      author: { login: "ana" },
                      body: "Handle the empty list.",
                      url: "https://github.com/acme/app/pull/12#discussion_r1",
                      diffHunk: "@@ -10,3 +10,5 @@\n const a = 1;\n+const b = 2;",
                    },
                    { author: null, body: "  Agreed.  " },
                  ],
                },
              },
              {
                id: "T2",
                isResolved: true,
                path: "src/done.ts",
                line: 3,
                comments: { nodes: [{ author: { login: "ana" }, body: "Fixed already." }] },
              },
              {
                id: "T3",
                isResolved: false,
                isOutdated: true,
                path: "src/old.ts",
                line: null,
                originalLine: 7,
                comments: { nodes: [{ author: { login: "bo" }, body: "Rename this." }] },
              },
            ],
          },
          reviews: {
            nodes: [
              { id: "R1", author: { login: "ana" }, state: "CHANGES_REQUESTED", body: "Needs tests." },
              { id: "R2", author: { login: "bo" }, state: "APPROVED", body: "" },
              { id: "R3", author: { login: "bo" }, state: "DISMISSED", body: "Old." },
            ],
          },
        },
      },
    },
  });

  it("reads unresolved threads and written reviews through the GraphQL API", async () => {
    const { runner, calls } = fakeRunner(({ args }) => {
      if (args.join(" ") === "pr view feature/pr --json number,url") return ok(PR_JSON);
      if (args[0] === "api") return ok(graphql);
      return undefined;
    });
    const result = await new PullRequestService(runner).comments(INPUT);
    expect(result).toEqual({
      number: 12,
      url: "https://github.com/acme/app/pull/12",
      threads: [
        {
          id: "T1",
          path: "src/app.ts",
          line: 14,
          startLine: 12,
          outdated: false,
          diffHunk: "@@ -10,3 +10,5 @@\n const a = 1;\n+const b = 2;",
          comments: [
            {
              author: "ana",
              body: "Handle the empty list.",
              url: "https://github.com/acme/app/pull/12#discussion_r1",
            },
            { author: "ghost", body: "Agreed." },
          ],
        },
        {
          id: "T3",
          path: "src/old.ts",
          line: 7,
          outdated: true,
          comments: [{ author: "bo", body: "Rename this." }],
        },
      ],
      reviews: [{ id: "R1", author: "ana", state: "CHANGES_REQUESTED", body: "Needs tests." }],
    });
    const api = calls.find((call) => call.args[0] === "api");
    expect(api?.args.slice(0, 3)).toEqual(["api", "graphql", "-f"]);
    expect(api?.args.slice(4)).toEqual(["-f", "owner=acme", "-f", "name=app", "-F", "number=12"]);
  });

  it("passes the host of a GitHub Enterprise pull request", async () => {
    const { runner, calls } = fakeRunner(({ args }) => {
      if (args[0] === "pr") return ok(JSON.stringify({ number: 4, url: "https://ghe.example.com/acme/app/pull/4" }));
      if (args[0] === "api") return ok(graphql);
      return undefined;
    });
    await new PullRequestService(runner).comments(INPUT);
    expect(calls.find((call) => call.args[0] === "api")?.args.slice(0, 4)).toEqual([
      "api",
      "graphql",
      "--hostname",
      "ghe.example.com",
    ]);
  });

  it("explains a branch without a pull request", async () => {
    const { runner } = fakeRunner();
    await expect(new PullRequestService(runner).comments(INPUT)).rejects.toThrow("no pull request yet");
  });

  it("explains a failed API call", async () => {
    const { runner } = fakeRunner(({ args }) => {
      if (args[0] === "pr") return ok(PR_JSON);
      if (args[0] === "api") return fail("HTTP 502: Bad Gateway");
      return undefined;
    });
    await expect(new PullRequestService(runner).comments(INPUT)).rejects.toThrow(PullRequestError);
  });
});

describe("review comment helpers", () => {
  it("reads only https pull request links with safe names", () => {
    expect(parsePullRequestLink(PR_JSON)).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "app",
      number: 12,
      url: "https://github.com/acme/app/pull/12",
    });
    expect(parsePullRequestLink(JSON.stringify({ number: 1, url: "http://github.com/a/b/pull/1" }))).toBeUndefined();
    expect(parsePullRequestLink(JSON.stringify({ number: 1, url: "https://github.com/-a/b/pull/1" }))).toBeUndefined();
    expect(parsePullRequestLink("not json")).toBeUndefined();
  });

  it("rejects an answer without a pull request", () => {
    expect(parseReviewComments(JSON.stringify({ data: { repository: null } }))).toBeUndefined();
    expect(parseReviewComments("{")).toBeUndefined();
  });

  it("keeps the end of a long hunk", () => {
    const hunk = ["@@ -1,20 +1,20 @@", ...Array.from({ length: 20 }, (_, index) => ` line ${index}`)].join("\n");
    const tail = hunkTail(hunk).split("\n");
    expect(tail).toHaveLength(12);
    expect(tail[0]).toBe(" line 8");
    expect(tail.at(-1)).toBe(" line 19");
    expect(hunkTail("@@ -1 +1 @@\n+one\n")).toBe("@@ -1 +1 @@\n+one");
  });
});
describe("helpers", () => {
  it("keeps the latest run of a check reported twice and lists failures first", () => {
    const checks = summarizeChecks([
      { name: "build", workflowName: "CI", conclusion: "SUCCESS", startedAt: "2026-01-01T00:00:00Z" },
      { name: "build", workflowName: "CI", conclusion: "FAILURE", startedAt: "2026-01-01T00:05:00Z" },
      { name: "lint", workflowName: "CI", conclusion: "SKIPPED" },
      { name: "e2e", workflowName: "CI", status: "IN_PROGRESS", conclusion: "" },
      { context: "", state: "SUCCESS" },
      { name: "docs", conclusion: "SUCCESS", detailsUrl: "javascript:alert(1)" },
    ]);
    expect(checks).toEqual([
      { name: "build", workflow: "CI", state: "failed" },
      { name: "e2e", workflow: "CI", state: "pending" },
      { name: "docs", state: "passed" },
      { name: "lint", workflow: "CI", state: "skipped" },
    ]);
    expect(summarizeChecks(undefined)).toBeUndefined();
  });

  it("reads only GitHub Actions job links", () => {
    expect(actionsJob("https://github.com/acme/app/actions/runs/5/job/9")).toEqual({ repo: "acme/app", jobId: "9" });
    expect(actionsJob("https://ghe.example.com/acme/app/actions/runs/5/job/9")).toEqual({
      repo: "ghe.example.com/acme/app",
      jobId: "9",
    });
    expect(actionsJob("https://github.com/-x/app/actions/runs/5/job/9")).toBeUndefined();
    expect(actionsJob("https://user:pw@github.com/acme/app/actions/runs/5/job/9")).toBeUndefined();
    expect(actionsJob("http://github.com/acme/app/actions/runs/5/job/9")).toBeUndefined();
    expect(actionsJob("https://github.com/acme/app/pull/3")).toBeUndefined();
  });

  it("keeps the end of a long failed step and the end of a job without an error marker", () => {
    const long = ["##[group]Run make", ...Array.from({ length: 200 }, (_, index) => `line ${index}`), "##[error]boom"];
    const result = failedLogExcerpt(long.join("\n"));
    expect(result.truncated).toBe(true);
    expect(result.excerpt.split("\n")).toHaveLength(150);
    expect(result.excerpt.endsWith("line 199\nerror: boom")).toBe(true);
    expect(failedLogExcerpt("one\ntwo\nPost job cleanup.\nthree")).toEqual({ excerpt: "one\ntwo", truncated: false });
  });

  it("formats commit subjects as a list and caps it", () => {
    expect(formatBody(["One", "Two"])).toBe("- One\n- Two");
    const many = Array.from({ length: 52 }, (_, index) => `Commit ${index}`);
    expect(formatBody(many).split("\n").at(-1)).toBe("- and 2 more commits");
  });

  it("redacts tokens and URL credentials", () => {
    const redacted = redactSecrets(
      "https://me:hunter2@github.com/x token: ghp_0123456789abcdef github_pat_11ABCDEFG0123456789 Authorization: Bearer abc",
    );
    expect(redacted).not.toMatch(/hunter2|ghp_0123|github_pat_11|abc/u);
    expect(redactSecrets("Bearer xyz and password=pw")).toBe("Bearer [redacted] and password=[redacted]");
  });
});
