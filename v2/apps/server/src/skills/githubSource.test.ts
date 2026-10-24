import { describe, expect, it } from "vitest";

import {
  fetchGithubSkills,
  GithubRateLimitError,
  isCommitSha,
  latestGithubCommit,
  parseGithubSkillSource,
} from "./githubSource.js";
import { fakeFetch, githubTarball } from "./testTarball.js";

const skill = (name: string, description = `Does ${name}.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps.\n`;

describe("GitHub skill sources", () => {
  it("reads folder links and owner/repo forms", () => {
    expect(parseGithubSkillSource("https://github.com/anthropics/skills/tree/main/skills/pdf")).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: "main",
      path: "skills/pdf",
    });
    expect(parseGithubSkillSource("github.com/o/r/blob/v1/a/SKILL.md")).toEqual({
      owner: "o",
      repo: "r",
      ref: "v1",
      path: "a",
    });
    expect(parseGithubSkillSource(" o/r.git ")).toEqual({ owner: "o", repo: "r", path: "" });
    expect(parseGithubSkillSource("o/r/skills/x?tab=1")).toEqual({ owner: "o", repo: "r", path: "skills/x" });
    expect(parseGithubSkillSource("https://gitlab.com/o/r")).toEqual({
      problem: "Only github.com links are supported.",
    });
    expect(parseGithubSkillSource("o")).toEqual({ problem: "Use a GitHub link or the form owner/repo." });
    expect(parseGithubSkillSource("o/r/tree/main/../etc")).toEqual({ problem: "The folder in the link is not valid." });
    expect(parseGithubSkillSource("o/r/tree/a..b")).toEqual({ problem: "The branch or tag name is not valid." });
  });

  it("finds each skill folder under the path and leaves unsafe ones out", async () => {
    const seen: string[] = [];
    const tarball = githubTarball([
      { path: "skills/", type: "5" },
      { path: "skills/pdf/SKILL.md", text: skill("pdf") },
      { path: "skills/pdf/scripts/fill.py", text: "print(1)", pax: true },
      { path: "skills/pdf/nested/SKILL.md", text: skill("nested") },
      { path: "skills/linked/SKILL.md", text: skill("linked") },
      { path: "skills/linked/escape", type: "2", linkName: "/etc/passwd" },
      { path: "skills/Bad_Name/SKILL.md", text: skill("Bad_Name") },
      { path: "skills/no-desc/SKILL.md", text: "---\nname: no-desc\n---\n" },
      { path: "other/SKILL.md", text: skill("other") },
    ]);
    const skills = await fetchGithubSkills(
      { owner: "o", repo: "r", ref: "main", path: "skills" },
      { fetch: fakeFetch(tarball, seen), token: "secret" },
    );
    expect(seen[0]).toContain("https://api.github.com/repos/o/r/tarball/main");
    expect(seen[0]).toContain("Bearer secret");
    expect(skills.map((entry) => [entry.name, entry.path, entry.problem])).toEqual([
      ["Bad_Name", "skills/Bad_Name", expect.stringContaining("naming rule")],
      ["linked", "skills/linked", "It contains symbolic links, which ZLI does not install."],
      ["no-desc", "skills/no-desc", "SKILL.md has no description."],
      ["pdf", "skills/pdf", undefined],
    ]);
    const pdf = skills.find((entry) => entry.name === "pdf");
    expect(pdf?.files.map((file) => file.path).sort()).toEqual(["SKILL.md", "nested/SKILL.md", "scripts/fill.py"]);
  });

  it("explains a missing repository", async () => {
    await expect(
      fetchGithubSkills({ owner: "o", repo: "r", path: "" }, { fetch: fakeFetch(Buffer.alloc(0), [], 404) }),
    ).rejects.toThrow(/no repository, branch, or tag/u);
  });
});

describe("GitHub commits", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  it("reads a commit id as the ref, with or without a folder", () => {
    expect(parseGithubSkillSource(`https://github.com/o/r/tree/${sha}`)).toEqual({
      owner: "o",
      repo: "r",
      ref: sha,
      path: "",
    });
    expect(parseGithubSkillSource(`https://github.com/o/r/tree/${sha}/plugins/a`)).toEqual({
      owner: "o",
      repo: "r",
      ref: sha,
      path: "plugins/a",
    });
    expect(isCommitSha(sha)).toBe(true);
    expect(isCommitSha("main")).toBe(false);
    expect(isCommitSha(undefined)).toBe(false);
  });

  it("asks for the newest commit in a folder", async () => {
    const seen: string[] = [];
    const fetchCommits = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(`${String(input)} ${JSON.stringify(init?.headers ?? {})}`);
      return Response.json([{ sha: sha.toUpperCase() }]);
    }) as typeof fetch;
    expect(
      await latestGithubCommit(
        { owner: "o", repo: "r", ref: "v1", path: "plugins/a" },
        { fetch: fetchCommits, token: "t" },
      ),
    ).toBe(sha);
    expect(seen[0]).toContain("https://api.github.com/repos/o/r/commits?sha=v1&per_page=1&path=plugins%2Fa");
    expect(seen[0]).toContain("Bearer t");
    await latestGithubCommit({ owner: "o", repo: "r", path: "" }, { fetch: fetchCommits });
    expect(seen[1]).toContain("commits?sha=HEAD&per_page=1 ");
  });

  it("answers undefined when GitHub has nothing and throws on a rate limit", async () => {
    const answer = (response: () => Response) => (async () => response()) as unknown as typeof fetch;
    const source = { owner: "o", repo: "r", path: "" };
    expect(await latestGithubCommit(source, { fetch: answer(() => Response.json([])) })).toBeUndefined();
    expect(
      await latestGithubCommit(source, { fetch: answer(() => new Response("", { status: 404 })) }),
    ).toBeUndefined();
    const offline = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await latestGithubCommit(source, { fetch: offline })).toBeUndefined();
    const limited = answer(() => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    await expect(latestGithubCommit(source, { fetch: limited })).rejects.toBeInstanceOf(GithubRateLimitError);
    const forbidden = answer(() => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "40" } }));
    expect(await latestGithubCommit(source, { fetch: forbidden })).toBeUndefined();
  });
});
