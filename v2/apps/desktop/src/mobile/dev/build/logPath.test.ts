import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LOG_READ_MAX, nodeLogFiles, readBuildLog } from "./logPath.js";

let base: string;
let worktree: string;
let temp: string;
let outside: string;
const files = () => ({ ...nodeLogFiles, tmpdir: () => temp });

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "zli-logpath-"));
  worktree = join(base, "worktree");
  temp = join(base, "temp");
  outside = join(base, "outside");
  await Promise.all([mkdir(join(worktree, "logs"), { recursive: true }), mkdir(temp), mkdir(outside)]);
  await writeFile(join(worktree, "logs", "build.log"), "FAILURE: Build failed with an exception.\n");
  await writeFile(join(outside, "secret.txt"), "not a log\n");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("build log path", () => {
  it("reads a log inside the worktree, by a relative or an absolute path", async () => {
    expect((await readBuildLog("logs/build.log", worktree, files())).text).toContain("FAILURE");
    expect((await readBuildLog(join(worktree, "logs", "build.log"), worktree, files())).text).toContain("FAILURE");
    expect((await readBuildLog("logs/build.log", worktree, files())).cut).toBe(false);
  });

  it("reads a log in the temp folder", async () => {
    await writeFile(join(temp, "eas.log"), "[RUN_GRADLEW] done\n");
    expect((await readBuildLog(join(temp, "eas.log"), worktree, files())).text).toContain("RUN_GRADLEW");
  });

  it("refuses a path that leaves the worktree with ..", async () => {
    await expect(readBuildLog("../outside/secret.txt", worktree, files())).rejects.toMatchObject({
      message: "ZLI reads build logs only from this worktree or the temp folder.",
      status: 400,
    });
  });

  it("refuses a link, inside the worktree or pointing out of it", async () => {
    await symlink(join(outside, "secret.txt"), join(worktree, "logs", "link.log"));
    await symlink(join(worktree, "logs", "build.log"), join(worktree, "logs", "alias.log"));
    await expect(readBuildLog("logs/link.log", worktree, files())).rejects.toMatchObject({ status: 400 });
    await expect(readBuildLog("logs/alias.log", worktree, files())).rejects.toMatchObject({
      message: "logs/alias.log is a link. Pass the log file itself.",
      status: 400,
    });
  });

  it("refuses a directory", async () => {
    await expect(readBuildLog("logs", worktree, files())).rejects.toMatchObject({
      message: "logs is not a file.",
      status: 400,
    });
  });

  it("refuses when the contained path no longer names the opened file", async () => {
    const moved = { ...files(), stat: async () => ({ dev: -1, ino: -1 }) };
    await expect(readBuildLog("logs/build.log", worktree, moved)).rejects.toMatchObject({
      message: "ZLI reads build logs only from this worktree or the temp folder.",
      status: 400,
    });
  });

  it("answers 404 for a log that is not there", async () => {
    await expect(readBuildLog("logs/missing.log", worktree, files())).rejects.toMatchObject({ status: 404 });
  });

  it("reads only the end of a large log, starting at a whole line, and says so", async () => {
    const line = `${"x".repeat(99)}\n`;
    const body = `${"first line\n"}${line.repeat(Math.ceil((LOG_READ_MAX * 1.5) / line.length))}last line\n`;
    await writeFile(join(worktree, "logs", "big.log"), body);
    const read = await readBuildLog("logs/big.log", worktree, files());
    expect(read.cut).toBe(true);
    expect(read.text.length).toBeLessThanOrEqual(LOG_READ_MAX);
    expect(read.text.startsWith("x")).toBe(true);
    expect(read.text.split("\n")[0]).toHaveLength(99);
    expect(read.text).not.toContain("first line");
    expect(read.text.endsWith("last line\n")).toBe(true);
  });
});
