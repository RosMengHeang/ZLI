import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AgentHistoryScanner, recordCwd } from "./AgentHistoryScanner.js";

const jsonl = (...lines: unknown[]) => `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

describe("recordCwd", () => {
  it("reads Claude Code's cwd from any record and Codex's from session metadata", () => {
    expect(recordCwd("claude-code", JSON.stringify({ type: "user", cwd: "/repo" }))).toBe("/repo");
    expect(recordCwd("claude-code", JSON.stringify({ type: "summary" }))).toBeUndefined();
    expect(recordCwd("codex", JSON.stringify({ type: "session_meta", payload: { cwd: "/app" } }))).toBe("/app");
    expect(recordCwd("codex", JSON.stringify({ type: "turn_context", payload: { cwd: "/app" } }))).toBe("/app");
    expect(recordCwd("codex", JSON.stringify({ type: "event_msg", payload: { cwd: "/x" } }))).toBeUndefined();
    expect(recordCwd("codex", "{not json")).toBeUndefined();
  });
});

describe("AgentHistoryScanner", () => {
  it("lists the folders agents ran in, newest first, leaving out folders that are gone", async () => {
    const home = await mkdtemp(join(tmpdir(), "zli-history-"));
    try {
      const app = join(home, "app");
      const site = join(home, "site");
      await mkdir(app);
      await mkdir(site);
      const claudeDir = join(home, ".claude", "projects", "app");
      await mkdir(join(claudeDir, "c2"), { recursive: true });
      // The folder sits after a record without one, as in real transcripts.
      await writeFile(join(claudeDir, "c1.jsonl"), jsonl({ type: "summary" }, { type: "user", cwd: app }));
      await writeFile(join(claudeDir, "c2", "subagent.jsonl"), jsonl({ type: "user", cwd: join(home, "nested") }));
      await writeFile(join(claudeDir, "broken.jsonl"), "not json\n");
      const codexDir = join(home, ".codex", "sessions", "2026", "11", "02");
      await mkdir(codexDir, { recursive: true });
      const siteRollout = join(codexDir, "rollout-2026-11-02T08-00-00-x1.jsonl");
      await writeFile(siteRollout, jsonl({ type: "session_meta", payload: { id: "x1", cwd: site } }));
      await writeFile(
        join(codexDir, "rollout-2026-11-02T09-00-00-x2.jsonl"),
        jsonl({ type: "session_meta", payload: { id: "x2", cwd: app } }),
      );
      await writeFile(
        join(codexDir, "rollout-2026-11-02T10-00-00-x3.jsonl"),
        jsonl({ type: "session_meta", payload: { id: "x3", cwd: join(home, "gone") } }),
      );
      const past = new Date("2026-01-01T00:00:00.000Z");
      await utimes(siteRollout, past, past);

      const folders = await new AgentHistoryScanner({ home, env: {}, tempDir: join(home, "tmp") }).scan();
      expect(folders.map((folder) => folder.name)).toEqual(["app", "site"]);
      expect(folders[0]?.sources.sort()).toEqual(["claude-code", "codex"]);
      expect(folders[1]).toMatchObject({ path: site, sources: ["codex"], lastActiveAt: past.toISOString() });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("leaves out folders that are not projects: home, the temp folder, app data and buddy homes", async () => {
    const home = await mkdtemp(join(tmpdir(), "zli-history-"));
    try {
      const keep = join(home, "app");
      const temp = join(home, "tmp");
      const insideTemp = join(home, "tmp", "checkout");
      const roaming = join(home, "Roaming", "tool");
      const buddy = join(home, "Roaming", "zli-buddies-dev", "zli-buddy-homes", "builder-abef37");
      const appData = join(home, "AppData", "Local", "thing");
      for (const dir of [keep, insideTemp, roaming, buddy, appData]) await mkdir(dir, { recursive: true });
      const claudeDir = join(home, ".claude", "projects", "all");
      await mkdir(claudeDir, { recursive: true });
      for (const [index, cwd] of [keep, insideTemp, temp, roaming, buddy, appData, home].entries())
        await writeFile(join(claudeDir, `s${index}.jsonl`), jsonl({ type: "user", cwd }));

      const folders = await new AgentHistoryScanner({
        home,
        env: { APPDATA: join(home, "Roaming") },
        tempDir: join(home, "tmp"),
      }).scan();
      // A checkout inside temp is still a project; only the temp folder itself is left out.
      expect(folders.map((folder) => folder.path).sort()).toEqual([insideTemp, keep].sort());
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
