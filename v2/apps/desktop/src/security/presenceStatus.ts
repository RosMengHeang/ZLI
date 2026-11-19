export type PresenceStatus = { status: "unsupported" | "unavailable" | "off" | "on"; error?: string };

const STATUSES = new Set(["unsupported", "unavailable", "off", "on"]);

/** Keeps only the status and error text, so nothing else from the main process reaches the page. */
export function parsePresenceStatus(value: unknown): PresenceStatus {
  const raw = (value ?? {}) as { status?: unknown; error?: unknown };
  const status = typeof raw.status === "string" && STATUSES.has(raw.status) ? raw.status : "unsupported";
  const result: PresenceStatus = { status: status as PresenceStatus["status"] };
  if (typeof raw.error === "string") result.error = raw.error.slice(0, 300);
  return result;
}
