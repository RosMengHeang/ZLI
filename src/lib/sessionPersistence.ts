export const SESSION_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export interface SessionCheckpoint {
  schemaVersion: typeof SESSION_CHECKPOINT_SCHEMA_VERSION;
  projectId: string;
  agents: unknown[];
  paneTree: unknown;
  browser: unknown[];
  taxChatRoom: unknown | null;
  lastEventSequence: number;
  savedAt: string;
  [key: string]: unknown;
}

export interface SessionCheckpointError {
  code: "invalid_session_checkpoint";
  message: "Session checkpoint is invalid";
}

export type SessionCheckpointDecodeResult =
  | { ok: true; value: SessionCheckpoint }
  | { ok: false; error: SessionCheckpointError };

const invalidCheckpoint = (): SessionCheckpointDecodeResult => ({
  ok: false,
  error: {
    code: "invalid_session_checkpoint",
    message: "Session checkpoint is invalid",
  },
});

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, milliseconds = "0"] = match;
  const instant = new Date(Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute),
    Number(second), Number(milliseconds.padEnd(3, "0")),
  ));
  return instant.getUTCFullYear() === Number(year)
    && instant.getUTCMonth() === Number(month) - 1
    && instant.getUTCDate() === Number(day)
    && instant.getUTCHours() === Number(hour)
    && instant.getUTCMinutes() === Number(minute)
    && instant.getUTCSeconds() === Number(second);
}

export function isSessionCheckpoint(value: unknown): value is SessionCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const checkpoint = value as Record<string, unknown>;
  return checkpoint.schemaVersion === SESSION_CHECKPOINT_SCHEMA_VERSION
    && typeof checkpoint.projectId === "string"
    && checkpoint.projectId.trim().length > 0
    && Array.isArray(checkpoint.agents)
    && Object.prototype.hasOwnProperty.call(checkpoint, "paneTree")
    && Array.isArray(checkpoint.browser)
    && Object.prototype.hasOwnProperty.call(checkpoint, "taxChatRoom")
    && Number.isSafeInteger(checkpoint.lastEventSequence)
    && Number(checkpoint.lastEventSequence) >= 0
    && isIsoTimestamp(checkpoint.savedAt);
}

export function decodeSessionCheckpoint(value: unknown): SessionCheckpointDecodeResult {
  return isSessionCheckpoint(value) ? { ok: true, value } : invalidCheckpoint();
}
