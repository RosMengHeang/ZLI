import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureScratchFolder } from "./ScratchFolder.js";

describe("ensureScratchFolder", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("creates the folder and initializes a repository once", async () => {
    const root = await mkdtemp(join(tmpdir(), "zli-scratch-"));
    roots.push(root);
    const folder = join(root, "Scratch");
    const calls: string[][] = [];
    const git = async (args: string[], cwd: string) => {
      calls.push(args);
      await mkdir(join(cwd, ".git"));
    };
    await expect(ensureScratchFolder(folder, git)).resolves.toBe(folder);
    expect(existsSync(folder)).toBe(true);
    await ensureScratchFolder(folder, git);
    expect(calls).toEqual([["init", "--quiet"]]);
  });
});
