import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitProcess } from "../git/GitProcess.js";
import { excludePathspecs, oversizedUntracked, sweepTempObjects, tempObjectNames } from "./untrackedLimits.js";

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

  it("leaves out a whole folder with many big files, so the exclude list stays short", async () => {
    const cwd = await repo();
    await mkdir(join(cwd, "media"));
    for (let index = 0; index < 21; index += 1) await writeFile(join(cwd, "media", `v${index}.bin`), "x".repeat(2048));
    expect(await oversizedUntracked(git, cwd, { maxFileBytes: 1024, maxFolderFiles: 100 })).toEqual(["media"]);
  });

  it("handles odd folder names", async () => {
    const cwd = await repo();
    for (const name of ["big dir", "[odd]", "ünï"]) await files(join(cwd, name), 4);
    expect(await oversizedUntracked(git, cwd, limits)).toEqual(["[odd]", "big dir", "ünï"]);
  });
});

describe("sweepTempObjects", () => {
  it("removes only old temp folders", async () => {
    const objects = await mkdtemp(join(tmpdir(), "zli-objects-"));
    cleanup.push(() => rm(objects, { recursive: true, force: true }));
    const now = Date.now();
    const old = new Date(now - 11 * 60_000);
    for (const name of ["tmp_objdir-bulk-fsync-old", "tmp_objdir-bulk-fsync-new", "pack"]) {
      await mkdir(join(objects, name));
      await writeFile(join(objects, name, "x"), "x");
    }
    await utimes(join(objects, "tmp_objdir-bulk-fsync-old"), old, old);
    await utimes(join(objects, "pack"), old, old);
    expect(await sweepTempObjects(objects, now)).toBe(1);
    expect((await readdir(objects)).sort()).toEqual(["pack", "tmp_objdir-bulk-fsync-new"]);
  });

  it("removes temp folders a killed add just made, whatever their age", async () => {
    const objects = await mkdtemp(join(tmpdir(), "zli-objects-"));
    cleanup.push(() => rm(objects, { recursive: true, force: true }));
    await mkdir(join(objects, "tmp_objdir-bulk-fsync-other"));
    const before = await tempObjectNames(objects);
    await mkdir(join(objects, "tmp_objdir-bulk-fsync-killed"));
    expect(await sweepTempObjects(objects, Date.now(), 0, before)).toBe(1);
    expect(await readdir(objects)).toEqual(["tmp_objdir-bulk-fsync-other"]);
  });

  it("returns 0 for a missing folder", async () => {
    expect(await sweepTempObjects(join(tmpdir(), "zli-no-such-objects-folder"), Date.now())).toBe(0);
  });
});

describe("excludePathspecs", () => {
  it("excludes each path literally", () => {
    expect(excludePathspecs(["big dir"])).toEqual([":(exclude,literal)big dir"]);
  });
});
