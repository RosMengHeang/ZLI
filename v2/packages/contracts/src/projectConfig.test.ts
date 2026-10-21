import { describe, expect, it } from "vitest";

import { parseZliConfig, repoPatternProblem } from "./projectConfig.js";

describe("zli.json", () => {
  it("accepts copy patterns, setup commands, and shared prompts", () => {
    const parsed = parseZliConfig(
      JSON.stringify({
        version: 1,
        worktree: { copy: [".env", "config/*.local.json"], setup: ["pnpm install"] },
        prompts: [{ name: "Review", prompt: "Review the diff." }],
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      config: {
        version: 1,
        worktree: { copy: [".env", "config/*.local.json"], setup: ["pnpm install"] },
        prompts: [{ name: "Review", prompt: "Review the diff." }],
      },
    });
  });

  it("names the field that failed", () => {
    const unknownKey = parseZliConfig(JSON.stringify({ version: 1, worktree: { setpu: [] } }));
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) expect(unknownKey.message).toContain("worktree");

    const badCommand = parseZliConfig(JSON.stringify({ version: 1, worktree: { setup: ["a\nb"] } }));
    expect(badCommand.ok).toBe(false);
    if (!badCommand.ok) expect(badCommand.message).toContain("worktree.setup.0");

    const wrongVersion = parseZliConfig(JSON.stringify({ version: 2 }));
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) expect(wrongVersion.message).toContain("version must be 1");
  });

  it("reports malformed JSON without throwing", () => {
    const parsed = parseZliConfig("{ version: 1 ");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/^zli.json is not valid JSON/u);
  });

  it("rejects copy patterns that could leave the repository", () => {
    for (const pattern of [
      "../secret",
      "a/../../b",
      "/etc/passwd",
      "C:/Windows",
      "a\\b",
      ".git/config",
      "!x",
      "",
      " x",
      "a//b",
      "./x",
    ]) {
      expect(repoPatternProblem(pattern), pattern).toBeDefined();
    }
    for (const pattern of [".env", "config/*.json", "**/.env.local", "apps/web/.env"]) {
      expect(repoPatternProblem(pattern), pattern).toBeUndefined();
    }
    const parsed = parseZliConfig(JSON.stringify({ version: 1, worktree: { copy: ["../secret"] } }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("worktree.copy.0");
  });
});
