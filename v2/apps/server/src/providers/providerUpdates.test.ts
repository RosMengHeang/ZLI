import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  checkProviderUpdates,
  compareVersions,
  fullCommandPath,
  latestNpmVersion,
  parseVersion,
  planProviderUpdate,
  runUpdateCommand,
} from "./providerUpdates.js";

describe("planProviderUpdate", () => {
  it("updates an npm install on Windows through the npm that owns the shim", () => {
    const plan = planProviderUpdate("codex", "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd", "win32", () => false);
    expect(plan).toMatchObject({
      method: "npm",
      command: "npm.cmd",
      args: ["install", "-g", "--prefix", "C:\\Users\\me\\AppData\\Roaming\\npm", "@openai/codex@latest"],
      npmPackage: "@openai/codex",
    });
  });

  it("runs the npm beside a Node install by its full path", () => {
    const plan = planProviderUpdate("codex", "C:\\nvm4w\\nodejs\\codex.cmd", "win32", () => true);
    expect(plan.command).toBe("C:\\nvm4w\\nodejs\\npm.cmd");
  });

  it("finds a bare Windows command on PATH, so cmd.exe knows where it lives", () => {
    const env = { Path: "D:\\none;C:\\nvm4w\\nodejs" };
    const exists = (path: string) => path === "C:\\nvm4w\\nodejs\\npm.cmd";
    expect(fullCommandPath("npm.cmd", env, "win32", exists)).toBe("C:\\nvm4w\\nodejs\\npm.cmd");
    expect(fullCommandPath("npm.cmd", env, "linux", exists)).toBe("npm.cmd");
    expect(fullCommandPath("C:\\x\\npm.cmd", env, "win32", exists)).toBe("C:\\x\\npm.cmd");
  });

  it("uses bun, pnpm, and volta when they own the path", () => {
    expect(planProviderUpdate("gemini", "/home/me/.bun/bin/gemini", "linux")).toMatchObject({
      method: "bun",
      args: ["add", "-g", "@google/gemini-cli@latest"],
    });
    expect(planProviderUpdate("gemini", "/home/me/.local/share/pnpm/gemini", "linux").method).toBe("pnpm");
    expect(planProviderUpdate("codex", "/home/me/.volta/bin/codex", "linux").method).toBe("volta");
  });

  it("lets the Claude Code native install update itself", () => {
    const plan = planProviderUpdate("claude-code", "C:\\Users\\me\\.local\\bin\\claude.exe", "win32");
    expect(plan).toMatchObject({ method: "self", args: ["update"], display: "claude update" });
  });

  it("only shows a command for an install ZLI cannot place", () => {
    const plan = planProviderUpdate("codex", "/opt/tools/codex", "linux");
    expect(plan.method).toBe("manual");
    expect(plan.command).toBeUndefined();
    expect(plan.display).toBe("npm install -g @openai/codex@latest");
  });
});

describe("versions", () => {
  it("reads the number out of a version line", () => {
    expect(parseVersion("2.1.3 (Claude Code)")).toBe("2.1.3");
    expect(parseVersion("codex-cli 0.58.0-alpha.2")).toBe("0.58.0-alpha.2");
    expect(parseVersion("unknown")).toBeUndefined();
  });

  it("orders versions by number, a pre-release before its release", () => {
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(compareVersions("2.0.0-beta.1", "2.0.0")).toBeLessThan(0);
  });

  it("caches the registry answer", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, json: async () => ({ version: "9.9.9" }) };
    };
    expect(await latestNpmVersion("zli-test-pkg", fetchImpl, () => 0)).toBe("9.9.9");
    expect(await latestNpmVersion("zli-test-pkg", fetchImpl, () => 1)).toBe("9.9.9");
    expect(calls).toBe(1);
  });
});

describe("checkProviderUpdates", () => {
  it("marks an agent behind when a newer version is out, and leaves missing agents out", async () => {
    const updates = await checkProviderUpdates(
      [
        {
          provider: "codex",
          displayName: "Codex",
          status: "found",
          path: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
          version: "codex-cli 0.50.0",
        },
        { provider: "gemini", displayName: "Gemini", status: "missing", reason: "Not found" },
        { provider: "goose", displayName: "Goose", status: "found", path: "/usr/bin/goose", version: "1.2.0" },
      ],
      { platform: "win32", latest: async () => "0.60.0" },
    );
    expect(updates).toEqual([
      expect.objectContaining({
        provider: "codex",
        current: "0.50.0",
        latest: "0.60.0",
        status: "behind",
        canUpdate: true,
      }),
      expect.objectContaining({ provider: "goose", status: "unknown", method: "self", canUpdate: true }),
    ]);
  });
});

describe("runUpdateCommand", () => {
  const fake = (code: number, text: string) => () => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new EventEmitter();
    Object.assign(child, { stdout, stderr: new EventEmitter(), kill: () => true });
    setTimeout(() => {
      stdout.emit("data", text);
      child.emit("close", code);
    }, 0);
    return child;
  };

  it("keeps what the command printed, without color codes", async () => {
    expect(await runUpdateCommand("npm", [], fake(0, "\u001b[32madded 1 package\u001b[0m"))).toEqual({
      ok: true,
      output: "added 1 package",
    });
    expect((await runUpdateCommand("npm", [], fake(1, "EACCES"))).ok).toBe(false);
  });
});
