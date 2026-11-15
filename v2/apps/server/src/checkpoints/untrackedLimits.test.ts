import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitProcess } from "../git/GitProcess.js";
import { excludePathspecs, oversizedUntracked } from "./untrackedLimits.js";

const limits = { maxFileBytes: 1024, maxFolderFiles: 3 };
const git = new GitProcess();
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function repo(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zli-untracked-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await git.run(["init"], { cwd: directory });
  return directory;
}

async function files(folder: string, count: number, bytes = 10): Promise<void> {
  await mkdir(folder, { recursive: true });
  for (let index = 0; index < count; index += 1) await writeFile(join(folder, `f${index}.txt`), "x".repeat(bytes));
}

describe("oversizedUntracked", () => {
  it("leaves out an untracked file over the size limit", async () => {
    const cwd = await repo();
    await writeFile(join(cwd, "big.bin"), "x".repeat(2048));
    await writeFile(join(cwd, "small.txt"), "x".repeat(10));
    expect(await oversizedUntracked(git, cwd, limits)).toEqual(["big.bin"]);
  });

  it("leaves out an untracked folder with too many files", async () => {
    const cwd = await repo();
    await files(join(cwd, "build"), 4);
    await files(join(cwd, "few"), 3);
    expect(await oversizedUntracked(git, cwd, limits)).toEqual(["build"]);
  });

  it("lists a big file inside an untracked folder under the folder limit", async () => {
    const cwd = await repo();
    await files(join(cwd, "few"), 1);
    await writeFile(join(cwd, "few", "a.bin"), "x".repeat(2048));
    expect(await oversizedUntracked(git, cwd, limits)).toEqual(["few/a.bin"]);
  });

  it("ignores files git already ignores", async () => {
    const cwd = await repo();
    await writeFile(join(cwd, ".gitignore"), "out/\n");
    await files(join(cwd, "out"), 10, 2048);
    expect(await oversizedUntracked(git, cwd, limits)).toEqual([]);
  });

  it("handles odd folder names", async () => {
    const cwd = await repo();
    for (const name of ["big dir", "[odd]", "ünï"]) await files(join(cwd, name), 4);
    expect(await oversizedUntracked(git, cwd, limits)).toEqual(["[odd]", "big dir", "ünï"]);
  });
});

describe("excludePathspecs", () => {
  it("excludes each path literally", () => {
    expect(excludePathspecs(["big dir"])).toEqual([":(exclude,literal)big dir"]);
  });
});
