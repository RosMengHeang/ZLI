import { afterEach, describe, expect, it, vi } from "vitest";

import { GitProcess, GitProcessError } from "./GitProcess.js";

describe("GitProcess", () => {
  it("passes git arguments as an array and captures bounded output", async () => {
    const execute = vi.fn(async (args: readonly string[]) => ({
      code: 0,
      stdout: args.join(" "),
      stderr: "",
    }));
    const git = new GitProcess({ execute, maxOutputBytes: 8 });

    const result = await git.run(["status", "--short"], { cwd: "C:\\repo" });

    expect(execute).toHaveBeenCalledWith(["status", "--short"], expect.objectContaining({ cwd: "C:\\repo" }));
    expect(result.stdout).toBe("status -");
  });

  it("maps non-zero exit codes to a typed error with bounded stderr", async () => {
    const git = new GitProcess({
      execute: async () => ({ code: 128, stdout: "", stderr: "fatal: repository not found" }),
      maxOutputBytes: 11,
    });

    await expect(git.run(["status"], { cwd: "C:\\missing" })).rejects.toMatchObject({
      name: "GitProcessError",
      code: 128,
      stderr: "fatal: repo",
    });
  });

  it("forwards cancellation to the underlying executor", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (_args: readonly string[], options: { signal?: AbortSignal }) => {
      expect(options.signal).toBe(controller.signal);
      return { code: 0, stdout: "", stderr: "" };
    });
    const git = new GitProcess({ execute });

    await git.run(["status"], { cwd: "C:\\repo", signal: controller.signal });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
