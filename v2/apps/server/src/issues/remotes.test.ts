import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ProcessResult, ProcessRunner } from "../review/PullRequestService.js";
import { readGhHosts, readGlabHosts, readProjectRemotes, remoteHost } from "./remotes.js";

const ok = (stdout = ""): ProcessResult => ({ code: 0, stdout, stderr: "" });
const noHosts = { github: async () => [], gitlab: async () => [] };

function runnerWith(...lines: [string, string][]): ProcessRunner {
  return async () => ok(lines.map(([name, url]) => `${name}\t${url} (fetch)\n${name}\t${url} (push)\n`).join(""));
}

describe("readProjectRemotes", () => {
  it("puts origin's forge first and keeps each forge's host", async () => {
    const runner = runnerWith(["mirror", "git@github.com:acme/app.git"], ["origin", "https://gitlab.com/acme/app.git"]);
    expect(await readProjectRemotes(runner, "/repo", noHosts)).toEqual({
      sources: ["gitlab", "github"],
      hosts: { gitlab: "gitlab.com", github: "github.com" },
      host: "gitlab.com",
    });
  });

  it("knows hosts the CLIs are signed in to, and GitLab hosts by name", async () => {
    const known = { github: async () => ["code.corp.example"], gitlab: async () => ["git.corp.example"] };
    expect(
      await readProjectRemotes(runnerWith(["origin", "git@git.corp.example:a/b.git"]), "/repo", known),
    ).toMatchObject({
      sources: ["gitlab"],
      hosts: { gitlab: "git.corp.example" },
    });
    expect(
      await readProjectRemotes(runnerWith(["origin", "https://code.corp.example/a/b"]), "/repo", known),
    ).toMatchObject({
      sources: ["github"],
    });
    expect(
      await readProjectRemotes(runnerWith(["origin", "git@gitlab.company.com:a/b.git"]), "/repo", noHosts),
    ).toMatchObject({
      sources: ["gitlab"],
      hosts: { gitlab: "gitlab.company.com" },
    });
  });

  it("reads the CLI configs only for hosts it cannot place", async () => {
    let reads = 0;
    const counting = {
      github: async () => {
        reads += 1;
        return [];
      },
      gitlab: async () => [],
    };
    await readProjectRemotes(runnerWith(["origin", "git@github.com:a/b.git"]), "/repo", counting);
    expect(reads).toBe(0);
    await readProjectRemotes(runnerWith(["origin", "git@bitbucket.org:a/b.git"]), "/repo", counting);
    expect(reads).toBe(1);
  });

  it("names the host when no remote is on GitHub or GitLab", async () => {
    const runner = runnerWith(["origin", "git@bitbucket.org:acme/app.git"]);
    expect(await readProjectRemotes(runner, "/repo", noHosts)).toEqual({
      unavailable: { code: "other_host", host: "bitbucket.org" },
    });
  });

  it("leaves local paths and SSH aliases to gh when nothing else names a forge", async () => {
    expect(await readProjectRemotes(runnerWith(["origin", "/srv/git/app.git"]), "/repo", noHosts)).toEqual({
      sources: ["github"],
      hosts: {},
    });
    expect(
      await readProjectRemotes(
        runnerWith(["origin", "git@gitlab.com:a/b.git"], ["local", "/srv/git/app.git"]),
        "/repo",
        noHosts,
      ),
    ).toMatchObject({ sources: ["gitlab"] });
  });

  it("tells a folder without remotes from one that is not a repository", async () => {
    expect(await readProjectRemotes(async () => ok(""), "/repo", noHosts)).toEqual({
      unavailable: { code: "no_remote" },
    });
    const notRepo: ProcessRunner = async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
    expect(await readProjectRemotes(notRepo, "/repo", noHosts)).toEqual({ unavailable: { code: "not_repo" } });
  });
});

describe("remoteHost", () => {
  it("reads the host of URL and SSH remotes", () => {
    expect(remoteHost("https://user:secret@GitLab.Company.com:8443/acme/app.git")).toBe("gitlab.company.com");
    expect(remoteHost("ssh://git@github.com:22/acme/app.git")).toBe("github.com");
    expect(remoteHost("git@gitlab.com:acme/app.git")).toBe("gitlab.com");
    expect(remoteHost("github-work:acme/app.git")).toBe("github-work");
  });

  it("has no host for local paths", () => {
    expect(remoteHost("/srv/git/app.git")).toBeUndefined();
    expect(remoteHost("../app.git")).toBeUndefined();
    expect(remoteHost("file:///srv/git/app.git")).toBeUndefined();
    expect(remoteHost("C:\\repos\\app.git")).toBeUndefined();
    expect(remoteHost("C:/repos/app.git")).toBeUndefined();
  });
});

describe("CLI hosts", () => {
  it("reads the hosts gh is signed in to and GH_HOST", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zli-gh-hosts-"));
    try {
      await writeFile(
        join(dir, "hosts.yml"),
        "github.com:\n    user: octo\n    git_protocol: https\ngit.corp.example:\n    users:\n        octo:\n",
        "utf8",
      );
      expect(await readGhHosts({ GH_CONFIG_DIR: dir, GH_HOST: "ghe.other.example" })).toEqual([
        "ghe.other.example",
        "github.com",
        "git.corp.example",
      ]);
      expect(await readGhHosts({ GH_CONFIG_DIR: join(dir, "missing") })).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads the hosts in glab's config and the GitLab host variables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zli-glab-hosts-"));
    try {
      await mkdir(join(dir, "glab-cli"));
      await writeFile(
        join(dir, "glab-cli", "config.yml"),
        [
          "# glab config",
          "git_protocol: ssh",
          "hosts:",
          "    gitlab.com:",
          "        token: glpat-secret",
          "        api_protocol: https",
          '    "git.corp.example":',
          "        token: x",
          "aliases:",
          "    ci: pipeline ci",
          "",
        ].join("\n"),
        "utf8",
      );
      expect(
        await readGlabHosts({ XDG_CONFIG_HOME: dir, GITLAB_HOST: "https://gitlab.other.example/", GL_HOST: " " }),
      ).toEqual(["gitlab.other.example", "gitlab.com", "git.corp.example"]);
      expect(await readGlabHosts({ GLAB_CONFIG_DIR: join(dir, "missing") })).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
