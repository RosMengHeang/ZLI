import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { FIVE_HOUR_WINDOW, MONTHLY_WINDOW, type PlanLimitWindow, WEEKLY_WINDOW } from "@zli-v2/contracts";

import { clamp, isoTime, number, parseJson, record, retryAfterMs, secret } from "./answerFields.js";
import type { LimitRead } from "./PlanLimits.js";
import { jsonBody, type LimitReaderDeps, send } from "./readerDeps.js";

/** OpenCode Go's usage endpoint (packages/console routes/zen/go/v1/usage.ts in sst/opencode). */
export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const CONSOLE_URL = "https://opencode.ai/console";

export type OpenCodeLimitDeps = LimitReaderDeps & {
  /** Stored credentials from OpenCode's database as [integration, JSON value], best first. */
  credentials(databasePath: string): Promise<Array<[string, string]>>;
};

/** A key and whether it was stored for Go itself, rather than shared with OpenCode Zen. */
type Key = { key: string; forGo: boolean };

/**
 * Reads OpenCode Go's 5-hour, weekly, and monthly windows with the key OpenCode uses: one stored by
 * `/connect` in OpenCode's database or auth.json, or OPENCODE_API_KEY. A Zen key without a Go
 * subscription is turned away, so the next key is tried before the login counts as having no limits.
 */
export async function readOpenCodeLimits(deps: OpenCodeLimitDeps): Promise<LimitRead> {
  const keys = await openCodeKeys(deps);
  if (keys.length === 0) return { state: "signed-out", message: "No OpenCode Go key is set up.", windows: [] };
  let rejectedGoKey = false;
  for (const { key, forGo } of keys) {
    const response = await send(deps, OPENCODE_GO_USAGE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    if (!response) return { state: "error", message: "Could not reach OpenCode. ZLI will try again.", windows: [] };
    if (response.status === 429) {
      return {
        state: "error",
        message: "OpenCode is limiting usage checks. ZLI will try again later.",
        windows: [],
        retryAfterMs: retryAfterMs(response.headers.get("retry-after"), deps.now()),
      };
    }
    const body = await response.text().catch(() => "");
    const errorType = record(record(parseJson(body))?.error)?.type;
    const read = response.ok ? openCodeLimitRead(parseJson(body)) : undefined;
    if (read) return read;
    // A sign-in redirect can come back as a successful HTML page.
    const rejected =
      response.status === 401 ||
      response.status === 403 ||
      errorType === "AuthError" ||
      errorType === "EntitlementError" ||
      (response.headers.get("content-type") ?? "").includes("text/html");
    if (!rejected)
      return { state: "error", message: "OpenCode did not report usage. ZLI will try again.", windows: [] };
    if (forGo && (response.status === 401 || errorType === "AuthError")) rejectedGoKey = true;
  }
  return rejectedGoKey
    ? {
        state: "expired",
        message: "OpenCode turned down the Go key. Connect OpenCode Go again in OpenCode.",
        windows: [],
      }
    : { state: "unavailable", message: "This OpenCode key has no Go subscription.", windows: [] };
}

/** Undefined when the answer is not Go usage, such as a page or an error. */
export function openCodeLimitRead(body: unknown): LimitRead | undefined {
  const usage = record(record(body)?.usage);
  if (!usage) return undefined;
  const windows = (
    [
      ["rolling", FIVE_HOUR_WINDOW],
      ["weekly", WEEKLY_WINDOW],
      ["monthly", MONTHLY_WINDOW],
    ] as const
  ).flatMap(([key, durationMinutes]): PlanLimitWindow[] => {
    const window = record(usage[key]);
    const used = number(window?.percent);
    if (used === undefined) return [];
    const resetsAt = isoTime(window?.resetsAt);
    return [{ durationMinutes, usedPercent: clamp(used), ...(resetsAt ? { resetsAt } : {}) }];
  });
  return windows.length > 0 ? { state: "ok", windows } : undefined;
}

/**
 * OpenCode 2 stores keys in its database: a Go key as "opencode-go", and the Console connection,
 * which also carries Go, as "opencode". OpenCode 1 keeps the Go key in auth.json, or inline in
 * OPENCODE_AUTH_CONTENT, which then replaces the file. OPENCODE_API_KEY comes last.
 */
async function openCodeKeys(deps: OpenCodeLimitDeps): Promise<Key[]> {
  const keys: Key[] = [];
  const add = (key: string | undefined, forGo: boolean) => {
    if (key && !keys.some((known) => known.key === key)) keys.push({ key, forGo });
  };
  const inline = deps.env.OPENCODE_AUTH_CONTENT;
  for (const dir of dataDirs(deps)) {
    if (!inline && deps.env.OPENCODE_DB !== ":memory:") {
      const rows = await deps.credentials(join(dir, deps.env.OPENCODE_DB || "opencode.db")).catch(() => []);
      for (const [integration, value] of rows) {
        const stored = record(parseJson(value));
        if (stored?.type !== "key") continue;
        const server = record(stored.metadata)?.server;
        // A Console connection to a self-hosted server holds a key for that server, not opencode.ai.
        if (integration === "opencode" && typeof server === "string" && server.replace(/\/+$/u, "") !== CONSOLE_URL) {
          continue;
        }
        add(secret(stored.key), integration === "opencode-go");
      }
    }
    const auth = inline ?? (await deps.readFile(join(dir, "auth.json")).catch(() => undefined));
    const go = record(record(auth ? parseJson(auth) : undefined)?.["opencode-go"]);
    if (go?.type === "api") add(secret(go.key), true);
    if (inline) break;
  }
  add(secret(deps.env.OPENCODE_API_KEY), false);
  return keys;
}

/** OpenCode follows XDG on every platform; older Windows and macOS builds used the system folders. */
function dataDirs(deps: LimitReaderDeps): string[] {
  const dirs = [join(secret(deps.env.XDG_DATA_HOME) ?? join(deps.home, ".local", "share"), "opencode")];
  const appData = secret(deps.env.APPDATA);
  if (deps.platform === "win32" && appData) dirs.push(join(appData, "opencode"));
  if (deps.platform === "darwin") dirs.push(join(deps.home, "Library", "Application Support", "opencode"));
  return dirs;
}

/** Opens OpenCode's database read-only; a missing or locked file has no credentials to offer. */
export async function openCodeCredentials(databasePath: string): Promise<Array<[string, string]>> {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 100");
    const rows = database
      .prepare(
        `SELECT integration_id, value FROM credential
         WHERE integration_id IN ('opencode-go', 'opencode') AND active IS NOT 0
         ORDER BY integration_id = 'opencode-go' DESC, active DESC, time_created DESC LIMIT 8`,
      )
      .all();
    return rows.flatMap((row) =>
      typeof row.integration_id === "string" && typeof row.value === "string" ? [[row.integration_id, row.value]] : [],
    );
  } catch {
    return [];
  } finally {
    database?.close();
  }
}
