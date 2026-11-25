import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "../review/PullRequestService.js";
import { CloneError, cloneRepository, cloneTarget } from "./clone.js";

describe("cloneTarget", () => {
  it("reads clone URLs, forge page links and SSH remotes", async () => {
    expect(await cloneTarget("https://github.com/acme/app/tree/main/src", undefined)).toEqual({
      url: "https://github.com/acme/app.git",
      name: "app",
    });
    expect(await cloneTarget("https://gitlab.com/group/sub/app/-/merge_requests/3", undefined)).toEqual({
      url: "https://gitlab.com/group/sub/app.git",
      name: "app",
    });
    expect(await cloneTarget("https://codeberg.org/acme/app/src/branch/main", undefined)).toEqual({
      url: "https://codeberg.org/acme/app.git",
      name: "app",
    });
    expect(await cloneTarget("git@gitlab.com:acme/app.git", undefined)).toEqual({
      url: "git@gitlab.com:acme/app.git",
      name: "app",
    });
  });

  it("turns owner/repo into the forge's URL", async () => {
    expect((await cloneTarget("acme/app", "github")).url).toBe("https://github.com/acme/app.git");
    expect((await cloneTarget("acme/app", "gitlab")).url).toBe("https://gitlab.com/acme/app.git");
    expect((await cloneTarget("acme/app", "gitea", async () => ["git.example.org"])).url).toBe(
      "https://git.example.org/acme/app.git",
    );
    await expect(cloneTarget("acme/app", undefined)).rejects.toThrow(/Pick the forge/u);
  });

  it("refuses what isn't a repository", async () => {
    for (const bad of ["", "--upload-pack=x", "two words", "https://github.com/acme", "file:///etc"]) {
      await expect(cloneTarget(bad, "github")).rejects.toBeInstanceOf(CloneError);
    }
  });
});

describe("cloneRepository", () => {
  it("runs git clone into parent/name", async () => {
    const parent = await mkdtemp(join(tmpdir(), "zli-clone-"));
    try {
      const calls: string[][] = [];
      const runner: ProcessRunner = async (command, args) => {
        calls.push([command, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      };
      const result = await cloneRepository({ source: "acme/app", forge: "github", parent }, runner);
      expect(result.path).toBe(join(parent, "app"));
      expect(calls).toEqual([["git", "clone", "--", "https://github.com/acme/app.git", join(parent, "app")]]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("drops trailing dots and spaces Windows would strip from the folder name", async () => {
    const parent = await mkdtemp(join(tmpdir(), "zli-clone-"));
    try {
      const runner: ProcessRunner = async () => ({ code: 0, stdout: "", stderr: "" });
      const result = await cloneRepository({ source: "acme/app", forge: "github", parent, name: "app. . " }, runner);
      expect(result.path).toBe(join(parent, "app"));
      await expect(
        cloneRepository({ source: "acme/app", forge: "github", parent, name: ". ." }, runner),
      ).rejects.toThrow("Give the folder a name.");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("refuses a folder that already has files, before git runs", async () => {
    const parent = await mkdtemp(join(tmpdir(), "zli-clone-"));
    try {
      await mkdir(join(parent, "app"));
      await writeFile(join(parent, "app", "README.md"), "hi", "utf8");
      let ran = false;
      const runner: ProcessRunner = async () => {
        ran = true;
        return { code: 0, stdout: "", stderr: "" };
      };
      await expect(cloneRepository({ source: "acme/app", forge: "github", parent }, runner)).rejects.toThrow(
        /already exists and isn't empty/u,
      );
      expect(ran).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("says why git failed, without the token in the URL", async () => {
    const parent = await mkdtemp(join(tmpdir(), "zli-clone-"));
    try {
      const runner: ProcessRunner = async () => ({
        code: 128,
        stdout: "",
        stderr: "fatal: repository 'https://x:ghp_abcdefgh12345678@github.com/acme/app.git/' not found",
      });
      const error = (await cloneRepository({ source: "acme/app", forge: "github", parent }, runner).catch(
        (cause: unknown) => cause,
      )) as Error;
      expect(error.message).toContain("not found");
      expect(error.message).not.toContain("ghp_abcdefgh12345678");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
