/** Readers for provider answers, which are not documented and change without notice. */

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A number, or a string holding one; some providers send counts as strings. */
export function numeric(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim()) return number(Number(value));
  return number(value);
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 60) : undefined;
}

/** A token or key, trimmed but never shortened. */
export function secret(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** An ISO time from an ISO string or Unix seconds or milliseconds. */
export function isoTime(value: unknown): string | undefined {
  const at =
    typeof value === "number" && value > 0
      ? value > 1e11
        ? value
        : value * 1000
      : typeof value === "string" && value.trim()
        ? /^\d+$/u.test(value.trim())
          ? Number(value) > 1e11
            ? Number(value)
            : Number(value) * 1000
          : Date.parse(value)
        : Number.NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

/** Most providers limit these endpoints per token, so a 429 waits at least this long. */
export const RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 24 * 3_600_000;

/** How long to wait after a 429, from Retry-After in seconds or as a date, kept between 15 minutes and a day. */
export function retryAfterMs(header: string | null, now: number): number {
  const seconds = header ? Number(header) : Number.NaN;
  const wait = header && Number.isNaN(seconds) ? Date.parse(header) - now : seconds * 1000;
  return Number.isFinite(wait)
    ? Math.min(MAX_BACKOFF_MS, Math.max(RATE_LIMIT_BACKOFF_MS, wait))
    : RATE_LIMIT_BACKOFF_MS;
}

export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
