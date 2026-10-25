import { isPlainObject } from "../../browser-tool/browserTool.js";
import { type ProcessRunner, runProcess } from "../../review/PullRequestService.js";
import { type FetchLike, oauthErrorCode, SignInError, type TokenSet, tokenRequest } from "./oauth.js";

/**
 * Client ID of ZLI's GitHub OAuth App, which turns on browser sign-in for GitHub (device flow). GitHub has
 * no dynamic client registration, so without one ZLI reuses the GitHub CLI's login. Client IDs are public.
 * `ZLI_GITHUB_CLIENT_ID` overrides it.
 */
export const GITHUB_OAUTH_CLIENT_ID = "";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const REQUEST_TIMEOUT_MS = 15_000;

export function isGitHubIssuer(issuer: string): boolean {
  try {
    return new URL(issuer).host === "github.com";
  } catch {
    return false;
  }
}

export const GITHUB_CLI_NEEDED =
  "Signing in to GitHub in one click uses the GitHub CLI. Install it from cli.github.com, run gh auth login in a terminal, then try again. Or add the server with a personal access token instead.";

/** The GitHub CLI's saved token, or undefined when gh is missing or signed out. */
export async function githubCliToken(runner: ProcessRunner = runProcess): Promise<string | undefined> {
  try {
    const result = await runner("gh", ["auth", "token", "--hostname", "github.com"], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    const token = result.stdout.trim();
    return result.code === 0 && token ? token : undefined;
  } catch {
    return undefined;
  }
}

/** The GitHub login name for a token, for showing who is signed in. */
export async function githubLogin(token: string, fetchImpl: FetchLike = fetch): Promise<string | undefined> {
  try {
    const response = await fetchImpl(USER_URL, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "ZLI" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return isPlainObject(body) && typeof body.login === "string" ? body.login : undefined;
  } catch {
    return undefined;
  }
}

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  intervalMs: number;
};

/** Starts GitHub's device flow: the person enters `userCode` at `verificationUri`. */
export async function startDeviceFlow(
  clientId: string,
  scopes: readonly string[],
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<DeviceCode> {
  let response: Response;
  try {
    response = await fetchImpl(DEVICE_CODE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId, scope: scopes.join(" ") }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SignInError(`GitHub could not be reached. ${error instanceof Error ? error.message : ""}`.trim());
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (
    !response.ok ||
    !isPlainObject(body) ||
    typeof body.device_code !== "string" ||
    typeof body.user_code !== "string" ||
    typeof body.verification_uri !== "string"
  ) {
    const reason = isPlainObject(body) && typeof body.error_description === "string" ? body.error_description : "";
    throw new SignInError(`GitHub did not start the sign-in. ${reason}`.trim());
  }
  const expiresIn = Number(body.expires_in);
  const interval = Number(body.interval);
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    expiresAt: now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900) * 1000,
    intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 5) * 1000,
  };
}

/** Polls until the person approves the code, they deny it, it expires, or `signal` stops it. */
export async function pollDeviceFlow(
  clientId: string,
  code: DeviceCode,
  signal: AbortSignal,
  options: { fetch?: FetchLike; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TokenSet> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let interval = code.intervalMs;
  while (!signal.aborted) {
    if (now() > code.expiresAt) throw new SignInError("The GitHub code expired. Start the sign-in again.");
    await sleep(interval);
    if (signal.aborted) break;
    try {
      return await tokenRequest(
        TOKEN_URL,
        { device_code: code.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
        { clientId, auth: "none" },
        options.fetch,
        now,
      );
    } catch (error) {
      const reason = oauthErrorCode(error);
      if (reason === "authorization_pending") continue;
      if (reason === "slow_down") {
        interval += 5_000;
        continue;
      }
      if (reason === "access_denied") throw new SignInError("The GitHub sign-in was canceled.");
      if (reason === "expired_token") throw new SignInError("The GitHub code expired. Start the sign-in again.");
      throw error;
    }
  }
  throw new SignInError("Sign-in stopped.");
}
