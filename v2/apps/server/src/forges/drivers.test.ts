import { describe, expect, it } from "vitest";

import type { ProcessResult, ProcessRunner } from "../review/PullRequestService.js";
import { ForgeError } from "./ForgeDriver.js";
import { GiteaDriver, parseTeaPull } from "./GiteaDriver.js";
import { GitLabDriver, parseMergeRequest } from "./GitLabDriver.js";

const ok = (stdout = ""): ProcessResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): ProcessResult => ({ code: 1, stdout: "", stderr });

/** Answers each call with `reply`, or a ready CLI for version and auth checks, and records the calls. */
function recording(reply: (command: string, args: readonly string[]) => ProcessResult | undefined) {
  const calls: string[][] = [];
  const runner: ProcessRunner = async (command, args) => {
    calls.push([command, ...args]);
    const answer = reply(command, args);
    if (answer) return answer;
    if (args[0] === "version" || args[0] === "--version") return ok(`${command} 9.9.9`);
    if (args[0] === "auth") return ok("gitlab.com\n  ✓ Logged in to gitlab.com as octo (config)\n");
    return ok("");
  };
  return { runner, calls };
}

const MR_JSON = JSON.stringify({
  iid: 7,
  title: "Add login",
  description: "- Add login",
  state: "opened",
  draft: true,
  web_url: "https://gitlab.com/acme/app/-/merge_requests/7",
  source_branch: "feature",
  target_branch: "main",
  author: { username: "octo" },
  updated_at: "2026-11-17T10:00:00Z",
  head_pipeline: { status: "failed", web_url: "https://gitlab.com/acme/app/-/pipelines/1" },
  changes_count: "3",
});

describe("GitLabDriver", () => {
  it("reads a merge request and its pipeline", () => {
    expect(parseMergeRequest(MR_JSON)).toEqual({
      number: 7,
      url: "https://gitlab.com/acme/app/-/merge_requests/7",
      state: "OPEN",
      isDraft: true,
      title: "Add login",
      body: "- Add login",
      author: { login: "octo" },
      updatedAt: "2026-11-17T10:00:00Z",
      baseRefName: "main",
      headRefName: "feature",
      changedFiles: 3,
      checks: [{ name: "Pipeline", state: "failed", url: "https://gitlab.com/acme/app/-/pipelines/1" }],
    });
    expect(parseMergeRequest("<html>")).toBeUndefined();
  });

  it("has no merge request when glab finds none, and says why when glab fails", async () => {
    const none = recording((_c, args) =>
      args[0] === "mr" ? fail('no open merge request available for "feature"') : undefined,
    );
    expect(await new GitLabDriver(none.runner).view("/repo", "feature")).toBeUndefined();
    const broken = recording((_c, args) =>
      args[0] === "mr" ? fail("401 Unauthorized glpat-abcdefgh12345") : undefined,
    );
    const error = await new GitLabDriver(broken.runner).view("/repo", "feature").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ForgeError);
    expect((error as Error).message).toContain("could not look up the merge request");
    expect((error as Error).message).not.toContain("glpat-abcdefgh12345");
  });

  it("creates, merges and comments with glab", async () => {
    let created = false;
    const { runner, calls } = recording((_c, args) => {
      if (args[0] === "mr" && args[1] === "create") {
        created = true;
        return ok("https://gitlab.com/acme/app/-/merge_requests/7\n");
      }
      if (args[0] === "mr" && args[1] === "view") return created ? ok(MR_JSON) : fail("no merge request found");
      return undefined;
    });
    const driver = new GitLabDriver(runner);
    const request = await driver.create("/repo", {
      branch: "feature",
      title: "Add login",
      body: "- Add login",
      base: "main",
      draft: true,
    });
    expect(request.number).toBe(7);
    await driver.merge("/repo", 7, "squash");
    await driver.comment("/repo", 7, "Looks good");
    const run = calls.filter((call) => call[0] === "glab" && call[1] === "mr" && call[2] !== "view");
    expect(run).toEqual([
      [
        "glab",
        "mr",
        "create",
        "--source-branch",
        "feature",
        "--target-branch",
        "main",
        "--title",
        "Add login",
        "--description",
        "- Add login",
        "--yes",
        "--draft",
      ],
      ["glab", "mr", "merge", "7", "--yes", "--squash"],
      ["glab", "mr", "note", "7", "--message=Looks good"],
    ]);
  });

  it("keeps a comment that starts with a dash as the message, not a flag", async () => {
    const { runner, calls } = recording(() => undefined);
    await new GitLabDriver(runner).comment("/repo", 7, "- Thanks");
    expect(calls).toContainEqual(["glab", "mr", "note", "7", "--message=- Thanks"]);
  });

  it("names what to do when glab is missing, old or signed out", async () => {
    const missing: ProcessRunner = async () => {
      throw Object.assign(new Error("spawn glab ENOENT"), { code: "ENOENT" });
    };
    expect(await new GitLabDriver(missing).problem()).toMatchObject({ code: "cli_missing" });
    const old = recording((_c, args) => (args[0] === "version" ? ok("glab 1.20.0") : undefined));
    expect(await new GitLabDriver(old.runner).problem()).toMatchObject({ code: "cli_outdated" });
    const out = recording((_c, args) => (args[0] === "auth" ? fail("No token found") : undefined));
    expect(await new GitLabDriver(out.runner).problem()).toMatchObject({
      code: "cli_unauthenticated",
      message: expect.stringContaining("glab auth login"),
    });
  });
});

const PULLS = JSON.stringify([
  {
    index: "4",
    title: "WIP: Add login",
    body: "- Add login",
    state: "open",
    author: "octo",
    url: "https://git.example.org/acme/app/pulls/4",
    head: "feature",
    base: "main",
    updated: "2026-11-17T10:00:00Z",
  },
  { index: "3", title: "Old try", state: "closed", url: "https://git.example.org/acme/app/pulls/3", head: "feature" },
  { index: "2", title: "Other", state: "open", url: "https://git.example.org/acme/app/pulls/2", head: "other" },
]);

describe("GiteaDriver", () => {
  it("reads tea's pull requests and marks WIP titles as drafts", () => {
    expect(parseTeaPull(JSON.parse(PULLS)[0])).toMatchObject({
      number: 4,
      state: "OPEN",
      isDraft: true,
      headRefName: "feature",
      author: { login: "octo" },
    });
    expect(parseTeaPull({ title: "no link" })).toBeUndefined();
  });

  it("finds the open pull request from the branch", async () => {
    const { runner } = recording((_c, args) => (args[0] === "pulls" ? ok(PULLS) : undefined));
    const driver = new GiteaDriver(runner, async () => ["git.example.org"]);
    expect(await driver.view("/repo", "feature")).toMatchObject({ number: 4, state: "OPEN" });
    expect(await driver.view("/repo", "nothing")).toBeUndefined();
  });

  it("pages past the newest 50 to find an older pull request from the branch", async () => {
    const filler = Array.from({ length: 50 }, (_, i) => ({
      index: String(100 - i),
      title: `Other ${i}`,
      state: "open",
      url: `https://git.example.org/acme/app/pulls/${100 - i}`,
      head: `other-${i}`,
    }));
    const { runner, calls } = recording((_c, args) => {
      if (args[0] !== "pulls" || args[1] !== "list") return undefined;
      const page = args[args.indexOf("--page") + 1];
      return ok(page === "1" ? JSON.stringify(filler) : PULLS);
    });
    const driver = new GiteaDriver(runner, async () => ["git.example.org"]);
    expect(await driver.view("/repo", "feature")).toMatchObject({ number: 4, state: "OPEN" });
    expect(calls.filter((call) => call[1] === "pulls" && call[2] === "list")).toHaveLength(2);
  });

  it("creates a draft with a WIP title, merges with a style, and comments", async () => {
    const { runner, calls } = recording((_c, args) =>
      args[0] === "pulls" && args[1] === "list" ? ok(PULLS) : undefined,
    );
    const driver = new GiteaDriver(runner, async () => ["git.example.org"]);
    await driver.create("/repo", { branch: "feature", title: "Add login", body: "Body", base: "main", draft: true });
    await driver.merge("/repo", 4, "rebase");
    await driver.comment("/repo", 4, "- Thanks");
    expect(
      calls
        .filter((call) => call[1] !== "pulls" || call[2] !== "list")
        .filter((call) => call[0] === "tea" && call[1] !== "--version"),
    ).toEqual([
      [
        "tea",
        "pulls",
        "create",
        "--head",
        "feature",
        "--base",
        "main",
        "--title",
        "WIP: Add login",
        "--description",
        "Body",
      ],
      ["tea", "pulls", "merge", "4", "--style", "rebase"],
      ["tea", "comment", "--", "4", "- Thanks"],
    ]);
  });

  it("says when tea has no login", async () => {
    const { runner } = recording(() => undefined);
    expect(await new GiteaDriver(runner, async () => []).problem()).toMatchObject({
      code: "cli_unauthenticated",
      message: expect.stringContaining("tea login add"),
    });
  });

  it("turns output that is not JSON into a readable failure", async () => {
    const { runner } = recording((_c, args) => (args[0] === "pulls" ? ok("<html>502 Bad Gateway</html>") : undefined));
    const error = await new GiteaDriver(runner, async () => ["git.example.org"])
      .view("/repo", "feature")
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ForgeError);
  });
});
