import { describe, expect, it } from "vitest";

import {
  formatBody,
  type ProcessResult,
  type ProcessRunner,
  PullRequestError,
  PullRequestService,
  redactSecrets,
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
    expect(calls.at(-1)?.args).toEqual(["pr", "view", "feature/pr", "--json", "url,state,isDraft,number"]);
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

describe("helpers", () => {
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
