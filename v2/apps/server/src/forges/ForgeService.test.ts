import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "../review/PullRequestService.js";
import { FORGE_CLIS, ForgeService, parseAuthStatus, parseVersion, versionAtLeast } from "./ForgeService.js";

const missing = Object.assign(new Error("spawn tea ENOENT"), { code: "ENOENT" });

/** A runner that answers per CLI and subcommand, and counts each run. */
function fakeRunner(answers: Record<string, { code?: number; stdout?: string; stderr?: string } | "missing">) {
  const calls: string[] = [];
  const runner: ProcessRunner = async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(key);
    const answer = answers[key] ?? answers[command];
    if (answer === "missing" || answer === undefined) throw missing;
    return { code: answer.code ?? 0, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
  };
  return { runner, calls };
}

describe("forge CLI output", () => {
  it("reads versions and compares them part by part", () => {
    expect(parseVersion("gh version 2.98.0 (2026-08-20)\nhttps://github.com/cli/cli/releases/tag/v2.98.0")).toBe(
      "2.98.0",
    );
    expect(parseVersion("glab 1.46.1 (8b0d3a1)")).toBe("1.46.1");
    expect(parseVersion("Version: 0.9.2\tgolang: 1.21.5")).toBe("0.9.2");
    expect(versionAtLeast("2.98.0", "2.40.0")).toBe(true);
    expect(versionAtLeast("2.4.0", "2.40.0")).toBe(false);
    expect(versionAtLeast("1.40", "1.40.0")).toBe(true);
  });

  it("reads the accounts gh and glab are signed in to", () => {
    expect(
      parseAuthStatus(
        "github.com\n  ✓ Logged in to github.com account octo (keyring)\n  - Active account: true\nghe.corp.example\n  ✓ Logged in to ghe.corp.example account octo-work (GH_ENTERPRISE_TOKEN)\n",
      ),
    ).toEqual([
      { host: "github.com", login: "octo" },
      { host: "ghe.corp.example", login: "octo-work" },
    ]);
    expect(
      parseAuthStatus("gitlab.com\n  ✓ Logged in to gitlab.com as octo (/home/o/.config/glab-cli/config.yml)\n"),
    ).toEqual([{ host: "gitlab.com", login: "octo" }]);
    expect(parseAuthStatus("You are not logged into any GitHub hosts. To log in, run: gh auth login")).toEqual([]);
  });
});

describe("ForgeService", () => {
  it("says which CLIs are ready, missing, outdated or signed out", async () => {
    const { runner } = fakeRunner({
      "gh --version": { stdout: "gh version 2.98.0 (2026-08-20)" },
      "gh auth status": { stdout: "github.com\n  ✓ Logged in to github.com account octo (keyring)\n" },
      "glab version": { stdout: "glab 1.30.0 (abc)" },
      "tea --version": { stdout: "Version: 0.9.2" },
    });
    const service = new ForgeService(
      runner,
      async () => [],
      () => new Date("2026-11-17T10:00:00.000Z"),
    );
    const { forges, checkedAt } = await service.status();
    expect(checkedAt).toBe("2026-11-17T10:00:00.000Z");
    expect(forges.map((forge) => [forge.kind, forge.state, forge.version ?? "", forge.accounts])).toEqual([
      ["github", "ready", "2.98.0", [{ host: "github.com", login: "octo" }]],
      ["gitlab", "outdated", "1.30.0", []],
      ["gitea", "signed_out", "0.9.2", []],
    ]);
    expect(forges.map((forge) => forge.signInCommand)).toEqual(FORGE_CLIS.map((info) => info.signInCommand));
  });

  it("marks a CLI that is not on PATH as missing, and one with unreadable output as an error", async () => {
    const { runner } = fakeRunner({ gh: "missing", glab: "missing", "tea --version": { stdout: "tea" } });
    const { forges } = await new ForgeService(runner, async () => []).status();
    expect(forges.map((forge) => forge.state)).toEqual(["missing", "missing", "error"]);
  });

  it("lists tea's servers as its accounts", async () => {
    const { runner } = fakeRunner({ gh: "missing", glab: "missing", "tea --version": { stdout: "Version: 0.10.1" } });
    const { forges } = await new ForgeService(runner, async () => ["git.example.org"]).status();
    expect(forges[2]).toMatchObject({ state: "ready", accounts: [{ host: "git.example.org" }] });
  });

  it("checks once until a rescan", async () => {
    const { runner, calls } = fakeRunner({ gh: "missing", glab: "missing", tea: "missing" });
    const service = new ForgeService(runner, async () => []);
    await service.status();
    await service.status();
    expect(calls).toHaveLength(3);
    await service.rescan();
    expect(calls).toHaveLength(6);
  });
});
