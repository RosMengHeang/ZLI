import { describe, expect, it } from "vitest";

import type { ProcessResult, ProcessRunner } from "../review/PullRequestService.js";
import { PublishError, publishRepository } from "./publish.js";

const ok = (stdout = ""): ProcessResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = ""): ProcessResult => ({ code: 1, stdout: "", stderr });

/** A repository with one commit and no origin; every forge CLI ready. */
function fake(over: (line: string) => ProcessResult | undefined = () => undefined) {
  const calls: string[] = [];
  let origin = false;
  const runner: ProcessRunner = async (command, args) => {
    const line = `${command} ${args.join(" ")}`;
    calls.push(line);
    const answer = over(line);
    if (answer) return answer;
    if (line === "git rev-parse --verify --quiet HEAD") return ok("abc\n");
    if (line === "git remote get-url origin") return origin ? ok("x") : fail("No such remote");
    if (line.startsWith("git remote add origin")) {
      origin = true;
      return ok();
    }
    if (args[0] === "--version" || args[0] === "version") return ok(`${command} 9.9.9`);
    if (args[0] === "auth") return ok("✓ Logged in to example.com account octo (keyring)");
    if (line.startsWith("gh repo create")) return ok("https://github.com/octo/app\n");
    if (line.startsWith("glab repo create"))
      return ok("✓ Created repository octo/app on GitLab: https://gitlab.com/octo/app\n");
    if (line.startsWith("tea repo create")) {
      return ok(
        JSON.stringify({
          html_url: "https://git.example.org/octo/app",
          clone_url: "https://git.example.org/octo/app.git",
        }),
      );
    }
    return ok();
  };
  return { runner, calls };
}

describe("publishRepository", () => {
  it("lets gh create the repository, add origin and push", async () => {
    const { runner, calls } = fake();
    expect(await publishRepository("/repo", { forge: "github", name: "app", private: true }, runner)).toEqual({
      url: "https://github.com/octo/app",
    });
    expect(calls).toContain("gh repo create app --private --source . --remote origin --push");
    expect(calls.some((line) => line.startsWith("git push"))).toBe(false);
  });

  it("creates on GitLab, adds origin and pushes the branch", async () => {
    const { runner, calls } = fake();
    const result = await publishRepository(
      "/repo",
      { forge: "gitlab", owner: "team", name: "app", private: false },
      runner,
    );
    expect(result.url).toBe("https://gitlab.com/octo/app");
    expect(calls).toContain("glab repo create team/app --public --defaultBranch main");
    expect(calls).toContain("git remote add origin https://gitlab.com/octo/app.git");
    expect(calls).toContain("git push -u origin HEAD");
  });

  it("creates on Gitea with tea and uses its clone URL", async () => {
    const { runner, calls } = fake();
    const result = await publishRepository(
      "/repo",
      { forge: "gitea", name: "app", private: true },
      runner,
      async () => ["git.example.org"],
    );
    expect(result.url).toBe("https://git.example.org/octo/app");
    expect(calls).toContain("tea repo create --name app --private --output json");
    expect(calls).toContain("git remote add origin https://git.example.org/octo/app.git");
  });

  it("asks for a first commit, and refuses a repository that already has origin", async () => {
    const empty = fake((line) => (line === "git rev-parse --verify --quiet HEAD" ? fail() : undefined));
    await expect(
      publishRepository("/repo", { forge: "github", name: "app", private: true }, empty.runner),
    ).rejects.toThrow("Make a first commit, then publish.");
    const linked = fake((line) => (line === "git remote get-url origin" ? ok("https://x") : undefined));
    await expect(
      publishRepository("/repo", { forge: "github", name: "app", private: true }, linked.runner),
    ).rejects.toThrow(/already has an origin/u);
  });

  it("refuses bad names and a signed-out CLI before creating anything", async () => {
    const { runner, calls } = fake((line) => (line.startsWith("glab auth") ? fail("not logged in") : undefined));
    await expect(
      publishRepository("/repo", { forge: "github", name: "my app", private: true }, runner),
    ).rejects.toBeInstanceOf(PublishError);
    await expect(publishRepository("/repo", { forge: "gitlab", name: "app", private: true }, runner)).rejects.toThrow(
      /glab auth login/u,
    );
    expect(calls.some((line) => line.includes("repo create"))).toBe(false);
  });
});
