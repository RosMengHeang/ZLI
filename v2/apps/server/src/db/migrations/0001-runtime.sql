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
