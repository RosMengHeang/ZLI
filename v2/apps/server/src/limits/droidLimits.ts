import { createDecipheriv } from "node:crypto";
import { join } from "node:path";

import { FIVE_HOUR_WINDOW, MONTHLY_WINDOW, type PlanLimitWindow, WEEKLY_WINDOW } from "@zli-v2/contracts";

import { clamp, isoTime, jwtExpiry, number, parseJson, record, retryAfterMs, secret } from "./answerFields.js";
import type { LimitRead } from "./PlanLimits.js";
import { jsonBody, type LimitReaderDeps, send } from "./readerDeps.js";

/** What Droid's own /limits command calls. It is not documented. */
export const FACTORY_LIMITS_URL = "https://api.factory.ai/api/billing/limits";
/** Droid encrypts its login with a key it keeps in the system credential store under these names. */
const KEY_SERVICE = "Factory CLI";
const KEY_ACCOUNT = "auth-encryption-key";

/**
 * Reads Droid's Standard and Droid Core windows (5 hours, a week, a month). An API key, given or in
 * FACTORY_API_KEY, wins over the sign-in, as it does for Droid. The sign-in token is only read:
 * Droid renews it the next time it runs.
 */
export async function readDroidLimits(apiKey: string | undefined, deps: LimitReaderDeps): Promise<LimitRead> {
  const key = apiKey ?? secret(deps.env.FACTORY_API_KEY);
  const token = key ?? (await droidLoginToken(deps));
  if (!token) return { state: "signed-out", message: "Not signed in to Droid.", windows: [] };
  const expiresAt = key ? undefined : jwtExpiry(token);
  if (expiresAt !== undefined && expiresAt <= deps.now()) return expired(false);
  const response = await send(deps, FACTORY_LIMITS_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!response) return { state: "error", message: "Could not reach Factory. ZLI will try again.", windows: [] };
  if (response.status === 401 || response.status === 403) return expired(Boolean(key));
  if (response.status === 429) {
    return {
      state: "error",
      message: "Factory is limiting usage checks. ZLI will try again later.",
      windows: [],
      retryAfterMs: retryAfterMs(response.headers.get("retry-after"), deps.now()),
    };
  }
  if (!response.ok)
    return { state: "error", message: "Factory did not report usage. ZLI will try again.", windows: [] };
  return droidLimitRead(await jsonBody(response));
}

function expired(apiKey: boolean): LimitRead {
  return {
    state: "expired",
    message: apiKey
      ? "Factory turned down this API key. Check the key in Settings, Accounts."
      : "The Droid sign-in needs a refresh. Open Droid once.",
    windows: [],
  };
}

/**
 * Standard windows are the whole plan; Droid Core, Factory's pool of open models, has its own. A
 * window with no end has not started yet. Plans billed the older way report no windows here.
 */
export function droidLimitRead(body: unknown): LimitRead {
  const answer = record(body);
  const limits = record(answer?.limits);
  const standard = record(limits?.standard);
  if (answer?.usesTokenRateLimitsBilling !== true || !standard) {
    return { state: "unavailable", message: "This Factory plan reports no usage limits.", windows: [] };
  }
  const windows = [...droidPool(standard), ...droidPool(record(limits?.core), "Core")];
  if (windows.length === 0) {
    return { state: "unavailable", message: "This Factory plan reports no usage limits.", windows: [] };
  }
  return { state: "ok", windows };
}

function droidPool(pool: Record<string, unknown> | undefined, scope?: string): PlanLimitWindow[] {
  return (
    [
      ["fiveHour", FIVE_HOUR_WINDOW],
      ["weekly", WEEKLY_WINDOW],
      ["monthly", MONTHLY_WINDOW],
    ] as const
  ).flatMap(([key, durationMinutes]): PlanLimitWindow[] => {
    const window = record(pool?.[key]);
    const used = number(window?.usedPercent);
    if (used === undefined) return [];
    const resetsAt = isoTime(window?.windowEnd);
    return [
      { ...(scope ? { scope } : {}), durationMinutes, usedPercent: clamp(used), ...(resetsAt ? { resetsAt } : {}) },
    ];
  });
}

/**
 * Droid keeps its login in ~/.factory/auth.v2.keyring as "iv:tag:ciphertext" in base64, AES-256-GCM,
 * with the key in the credential store. Without a store it falls back to auth.v2.file, and to
 * auth.v2.key for the key.
 */
async function droidLoginToken(deps: LimitReaderDeps): Promise<string | undefined> {
  const dir = join(deps.home, ".factory");
  const envelopes = (
    await Promise.all(
      ["auth.v2.keyring", "auth.v2.file"].map((name) => deps.readFile(join(dir, name)).catch(() => undefined)),
    )
  ).filter((value): value is string => Boolean(value?.trim()));
  if (envelopes.length === 0) return undefined;
  const keys = [
    await deps.secretStore(KEY_SERVICE, KEY_ACCOUNT).catch(() => undefined),
    await deps.readFile(join(dir, "auth.v2.key")).catch(() => undefined),
  ].flatMap((value) => {
    const key = value ? encryptionKey(value) : undefined;
    return key ? [key] : [];
  });
  for (const envelope of envelopes) {
    const plain = record(parseJson(envelope.trim()));
    const direct = secret(plain?.access_token);
    if (direct) return direct;
    for (const key of keys) {
      const token = secret(record(parseJson(decrypt(envelope, key) ?? ""))?.access_token);
      if (token) return token;
    }
  }
  return undefined;
}

function encryptionKey(value: string): Buffer | undefined {
  const text = value.trim();
  const key = /^[0-9a-f]{64}$/iu.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  return key.length === 32 ? key : undefined;
}

export function decrypt(envelope: string, key: Buffer): string | undefined {
  const parts = envelope.trim().split(":");
  if (parts.length !== 3) return undefined;
  const [iv, tag, data] = parts.map((part) => Buffer.from(part, "base64"));
  if (!iv || !tag || !data || iv.length === 0 || tag.length !== 16) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}
