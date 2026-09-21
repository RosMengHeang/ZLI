import { DatabaseSync } from "node:sqlite";

export type SqliteValue = string | number | bigint | Uint8Array | null;

type Migration = {
  id: string;
  sql: string;
};

const migrations: Migration[] = [
  {
    id: "0001-runtime",
    sql: `
      CREATE TABLE IF NOT EXISTS commands (
        command_id TEXT PRIMARY KEY,
        intent_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        command_id TEXT,
        event_type TEXT NOT NULL,
        event_version INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        FOREIGN KEY (command_id) REFERENCES commands(command_id)
      );
      CREATE INDEX IF NOT EXISTS events_command_id_idx ON events(command_id);
      CREATE TABLE IF NOT EXISTS projection_state (
        projection_id INTEGER PRIMARY KEY CHECK (projection_id = 1),
        revision INTEGER NOT NULL,
        projection_json TEXT NOT NULL
      );
    `,
  },
];

export class Database {
  readonly raw: DatabaseSync;

  constructor(options: { path: string }) {
    this.raw = new DatabaseSync(options.path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.raw.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    this.applyMigrations();
  }

  execute(sql: string, parameters: SqliteValue[] = []): void {
    this.raw.prepare(sql).run(...parameters);
  }

  transaction<T>(callback: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }

  private applyMigrations(): void {
    for (const migration of migrations) {
      const applied = this.raw
        .prepare("SELECT 1 AS applied FROM schema_migrations WHERE id = ?")
        .get(migration.id) as { applied?: number } | undefined;
      if (applied?.applied === 1) {
        continue;
      }
      this.transaction(() => {
        this.raw.exec(migration.sql);
        this.raw
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run(migration.id, new Date().toISOString());
      });
    }
  }
}
