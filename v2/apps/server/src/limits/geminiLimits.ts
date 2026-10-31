import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PlanLimitWindow } from "@zli-v2/contracts";

import { clamp, isoTime, number, parseJson, record, retryAfterMs, secret, text } from "./answerFields.js";
import type { LimitRead } from "./PlanLimits.js";
import { jsonBody, type LimitReaderDeps, send } from "./readerDeps.js";

/** Google's Code Assist endpoints behind Gemini CLI's /stats. They are not documented. */
const CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** A token this close to its expiry is treated as expired, so it cannot lapse mid-read. */
const EXPIRY_SKEW_MS = 60_000;

export type GeminiOAuthClient = { clientId: string; clientSecret: string };

export type GeminiLimitDeps = LimitReaderDeps & {
  /** Gemini CLI's own OAuth client, which a refresh must use; undefined when it cannot be found. */
  oauthClient(): Promise<GeminiOAuthClient | undefined>;
};

type Credentials = { accessToken?: string; refreshToken?: string; expiresAt?: number };
type Fresh = { refreshToken: string; accessToken: string; expiresAt: number };

/** Access tokens ZLI refreshed, per credentials file. They live only in memory. */
const refreshed = new Map<string, Fresh>();

const UNREACHABLE: LimitRead = { state: "error", message: "Could not reach Google. ZLI will try again.", windows: [] };
const SIGNED_OUT: LimitRead = { state: "signed-out", message: "Not signed in to Gemini CLI with Google.", windows: [] };
const EXPIRED: LimitRead = {
  state: "expired",
  message: "The Gemini sign-in needs a refresh. Open Gemini CLI with this account once.",
  windows: [],
};

/**
 * Reads the daily per-model quotas for the Google login in `cliHome` (GEMINI_CLI_HOME, or the home
 * folder when undefined). Google access tokens last an hour, so an expired one is refreshed with
 * Gemini CLI's own client and kept in memory: the credentials file always stays as Gemini CLI wrote
 * it. Google does not rotate the refresh token, so the CLI's login keeps working.
 */
export async function readGeminiLimits(cliHome: string | undefined, deps: GeminiLimitDeps): Promise<LimitRead> {
  const dir = join(cliHome ?? deps.home, ".gemini");
  const authType = await selectedAuthType(dir, deps);
  if (authType && authType !== "oauth-personal") {
    // An API key or Vertex AI is billed by use; the file may still hold an older Google sign-in.
    return {
      state: "unavailable",
      message: "This Gemini login uses an API key, which has no plan limits.",
      windows: [],
    };
  }
  const path = join(dir, "oauth_creds.json");
  const file = await deps.readFile(path).catch(() => undefined);
  const credentials = file ? parseCredentials(file) : undefined;
  if (!credentials) return SIGNED_OUT;

  let token = await accessToken(path, credentials, deps, false);
  if (!token) return EXPIRED;
  let read = await readQuota(token, deps);
  if (read === "unauthorized") {
    token = await accessToken(path, credentials, deps, true);
    read = token ? await readQuota(token, deps) : "unauthorized";
  }
  return read === "unauthorized" ? EXPIRED : read;
}

async function readQuota(token: string, deps: GeminiLimitDeps): Promise<LimitRead | "unauthorized"> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" };
  const envProject = text(deps.env.GOOGLE_CLOUD_PROJECT) ?? text(deps.env.GOOGLE_CLOUD_PROJECT_ID);
  const setup = await send(deps, `${CODE_ASSIST_URL}:loadCodeAssist`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...(envProject ? { cloudaicompanionProject: envProject } : {}),
      metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI", ...(envProject ? { duetProject: envProject } : {}) },
    }),
  });
  if (!setup) return UNREACHABLE;
  const failed = failure(setup, deps);
  if (failed) return failed;
  const answer = record(await jsonBody(setup));
  const project =
    text(answer?.cloudaicompanionProject) ?? text(record(answer?.cloudaicompanionProject)?.id) ?? envProject;
  const tier = record(answer?.paidTier) ?? record(answer?.currentTier);
  const plan = text(tier?.name) ?? text(tier?.id);
  const withPlan = plan ? { plan } : {};
  if (!project) {
    // A Google login that has never run Gemini CLI has no Code Assist project, and so no quota yet.
    return {
      state: "unavailable",
      message: "This Google login has not used Gemini CLI yet.",
      windows: [],
      ...withPlan,
    };
  }
  const quota = await send(deps, `${CODE_ASSIST_URL}:retrieveUserQuota`, {
    method: "POST",
    headers,
    body: JSON.stringify({ project }),
  });
  if (!quota) return { ...UNREACHABLE, ...withPlan };
  const quotaFailed = failure(quota, deps);
  if (quotaFailed === "unauthorized") return quotaFailed;
  if (quotaFailed) return { ...quotaFailed, ...withPlan };
  return { ...geminiLimitRead(await jsonBody(quota)), ...withPlan };
}

function failure(response: Response, deps: GeminiLimitDeps): LimitRead | "unauthorized" | undefined {
  if (response.status === 401) return "unauthorized";
  if (response.status === 403) {
    return { state: "unavailable", message: "This Google login cannot read Gemini quotas.", windows: [] };
  }
  if (response.status === 429) {
    return {
      state: "error",
      message: "Google is limiting quota checks. ZLI will try again later.",
      windows: [],
      retryAfterMs: retryAfterMs(response.headers.get("retry-after"), deps.now()),
    };
  }
  if (!response.ok)
    return { state: "error", message: "Google did not report the quota. ZLI will try again.", windows: [] };
  return undefined;
}

/**
 * One window per model, named as Gemini CLI's /stats names it, with no length: Google resets each
 * model's quota on its own schedule and says only when. Preview and Vertex variants of a model share
 * its name, and the fullest of them counts.
 */
export function geminiLimitRead(body: unknown): LimitRead {
  const answer = record(body);
  const buckets = Array.isArray(answer?.buckets) ? answer.buckets : Array.isArray(body) ? body : [];
  const byModel = new Map<string, PlanLimitWindow>();
  for (const value of buckets) {
    const bucket = record(value);
    const remaining = number(bucket?.remainingFraction);
    const model = typeof bucket?.modelId === "string" ? modelName(bucket.modelId) : undefined;
    if (remaining === undefined || !model) continue;
    const resetsAt = isoTime(bucket?.resetTime);
    const window: PlanLimitWindow = {
      scope: model,
      // 1 - 0.42 is 58.00000000000001 in floating point.
      usedPercent: clamp(Math.round((1 - remaining) * 1000) / 10),
      ...(resetsAt ? { resetsAt } : {}),
    };
    const known = byModel.get(model.toLowerCase());
    if (!known || window.usedPercent > known.usedPercent) byModel.set(model.toLowerCase(), window);
  }
  const windows = [...byModel.values()].sort((left, right) => right.usedPercent - left.usedPercent).slice(0, 8);
  if (windows.length === 0) {
    return { state: "unavailable", message: "This Gemini login has no quota limits.", windows: [] };
  }
  return { state: "ok", windows };
}

/** "gemini-2.5-flash-lite-preview-06-17_vertex" becomes "2.5 Flash Lite". */
export function modelName(modelId: string): string | undefined {
  const words = modelId
    .trim()
    .replace(/_vertex$/iu, "")
    .replace(/^models\//iu, "")
    .replace(/^gemini-/iu, "")
    .replace(/-(preview|exp)(-[\d-]+)?$/iu, "")
    .replace(/-\d{3}$/u, "")
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return text(words.join(" "));
}

async function selectedAuthType(dir: string, deps: GeminiLimitDeps): Promise<string | undefined> {
  const settings = record(parseJson((await deps.readFile(join(dir, "settings.json")).catch(() => "")) || "null"));
  const auth = record(record(settings?.security)?.auth);
  return text(auth?.selectedType) ?? text(settings?.selectedAuthType);
}

function parseCredentials(raw: string): Credentials | undefined {
  const value = record(parseJson(raw));
  const accessToken = secret(value?.access_token);
  const refreshToken = secret(value?.refresh_token);
  if (!accessToken && !refreshToken) return undefined;
  const expiresAt = number(value?.expiry_date);
  return {
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

async function accessToken(
  path: string,
  credentials: Credentials,
  deps: GeminiLimitDeps,
  force: boolean,
): Promise<string | undefined> {
  const now = deps.now();
  const alive = (expiresAt: number | undefined) => expiresAt === undefined || expiresAt - EXPIRY_SKEW_MS > now;
  if (!force && credentials.accessToken && alive(credentials.expiresAt)) return credentials.accessToken;
  const kept = refreshed.get(path);
  if (!force && kept && kept.refreshToken === credentials.refreshToken && alive(kept.expiresAt))
    return kept.accessToken;
  refreshed.delete(path);
  if (!credentials.refreshToken) return undefined;
  const client = await deps.oauthClient().catch(() => undefined);
  if (!client) return undefined;
  const response = await send(deps, GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!response?.ok) return undefined;
  const answer = record(await jsonBody(response));
  const token = secret(answer?.access_token);
  if (!token) return undefined;
  const lifetime = number(answer?.expires_in) ?? 3_600;
  refreshed.set(path, { refreshToken: credentials.refreshToken, accessToken: token, expiresAt: now + lifetime * 1000 });
  return token;
}

const OAUTH2_FILE = join("dist", "src", "code_assist", "oauth2.js");
const clients = new Map<string, GeminiOAuthClient>();

/**
 * Gemini CLI's OAuth client ID and secret, read from the installed CLI's code. Google calls these
 * public for installed apps; they are not in ZLI because a refresh must use the client the CLI
 * signed in with. Covers npm, pnpm, bun, Homebrew, and Windows installs, and the bundled builds
 * Gemini CLI ships since 0.38.
 */
export async function findGeminiOAuthClient(command: string): Promise<GeminiOAuthClient | undefined> {
  const cached = clients.get(command);
  if (cached) return cached;
  const real = await realpath(command).catch(() => command);
  let dir = dirname(real);
  for (let level = 0; level < 9; level += 1) {
    for (const root of await packageRoots(dir)) {
      const client = await clientIn(root);
      if (client) {
        clients.set(command, client);
        return client;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

async function packageRoots(dir: string): Promise<string[]> {
  const nested = (base: string) => join(base, "node_modules", "@google", "gemini-cli");
  const candidates = [dir, nested(dir), nested(join(dir, "lib")), nested(join(dir, "libexec", "lib"))];
  const roots: string[] = [];
  for (const candidate of candidates) {
    const manifest = record(parseJson(await readFile(join(candidate, "package.json"), "utf8").catch(() => "null")));
    if (manifest?.name === "@google/gemini-cli") roots.push(candidate);
  }
  return roots;
}

async function clientIn(root: string): Promise<GeminiOAuthClient | undefined> {
  const sources = [
    join(root, "node_modules", "@google", "gemini-cli-core", OAUTH2_FILE),
    join(dirname(root), "gemini-cli-core", OAUTH2_FILE),
  ];
  const bundle = join(root, "bundle");
  const bundled = await readdir(bundle).catch(() => [] as string[]);
  sources.push(...bundled.filter((name) => name.endsWith(".js")).map((name) => join(bundle, name)));
  for (const source of sources) {
    if (
      !(await stat(source).then(
        (info) => info.isFile() && info.size < 64 * 1024 * 1024,
        () => false,
      ))
    )
      continue;
    const client = parseOAuthClient(await readFile(source, "utf8").catch(() => ""));
    if (client) return client;
  }
  return undefined;
}

export function parseOAuthClient(source: string): GeminiOAuthClient | undefined {
  const clientId = /OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/u.exec(source)?.[1];
  const clientSecret = /OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/u.exec(source)?.[1];
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** For tests, which share one module and its refreshed tokens. */
export function forgetGeminiTokens(): void {
  refreshed.clear();
}
