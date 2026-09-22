import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Database } from "./Database.js";

describe("Database migrations", () => {
  it("rolls back every schema change when a migration fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zli-database-migration-"));
    const path = join(directory, "runtime.sqlite");
    const seed = new DatabaseSync(path);
    seed.exec(
      "CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL); CREATE TABLE events (sequence INTEGER PRIMARY KEY);",
    );
    seed.close();

    try {
      expect(() => new Database({ path })).toThrow(/no such column: command_id/iu);

      const verification = new DatabaseSync(path);
      const commandTable = verification
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'commands'")
        .get();
      const appliedMigrations = verification.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as {
        count: number;
      };
      verification.close();

      expect(commandTable).toBeUndefined();
      expect(appliedMigrations.count).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
