import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { isPlainObject, writeFileAtomic } from "../../browser-tool/browserTool.js";
import type { ProcessRunner } from "../../review/PullRequestService.js";
import {
  GITHUB_CLI_NEEDED,
  githubCliToken,
  githubLogin,
  isGitHubIssuer,
  pollDeviceFlow,
  startDeviceFlow,
} from "./github.js";
import { startLoopback } from "./loopback.js";
import {
  authorizeUrl,
  createPkce,
  discoverSignIn,
  type FetchLike,
  type OAuthClient,
  randomState,
  registerClient,
  SignInError,
  type SignInDiscovery,
  tokenRequest,
} from "./oauth.js";
import { readSignIn, type SignInMethod, type StoredSignIn, signInUsable, writeSignIn } from "./tokenFile.js";

/** How long ZLI waits for the person to finish in the browser. */
const ATTEMPT_TIMEOUT_MS = 10 * 60_000;
const CLIENTS_FILE = "clients.json";

export type SignInStatus = {
  signedIn: boolean;
  via?: SignInMethod;
  account?: string;
  signedInAt?: string;
};

export type SignInStart = { status: "done" } | { status: "open"; attemptId: string; url: string; code?: string };

type Attempt = {
  serverUrl: string;
  controller: AbortController;
  done: Promise<{ ok: true } | { ok: false; error: unknown }>;
};

/** Same address, same login: case and a trailing slash do not make a different server. */
export function normalizeServerUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/u, "");
  } catch {
    return url.trim().replace(/\/+$/u, "");
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Signs in to remote MCP servers for every agent at once. Logins live in one private file per server,
 * which the connect bridge reads and refreshes, so a sign-in here reaches agents in terminals and chats.
 */
export class McpSignIns {
  private readonly cache = new Map<string, StoredSignIn>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly fetch: FetchLike;

  constructor(
    private readonly options: {
      dir: string;
      fetch?: FetchLike;
      githubClientId?: string;
      runner?: ProcessRunner;
      /** Replaces the GitHub CLI lookup in tests. */
      githubCliToken?: () => Promise<string | undefined>;
      callbackPorts?: readonly number[];
      now?: () => number;
    },
  ) {
    this.fetch = options.fetch ?? fetch;
  }

  async load(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.options.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name === CLIENTS_FILE) continue;
      const stored = await readSignIn(join(this.options.dir, name));
      if (stored) this.cache.set(normalizeServerUrl(stored.serverUrl), stored);
    }
  }

  /** Where the login for one server is saved. The bridge an agent starts reads this file. */
  tokenFile(serverUrl: string): string {
    const key = createHash("sha256").update(normalizeServerUrl(serverUrl)).digest("hex").slice(0, 24);
    return join(this.options.dir, `${key}.json`);
  }

  status(serverUrl: string): SignInStatus {
    const stored = this.cache.get(normalizeServerUrl(serverUrl));
    if (!stored || !signInUsable(stored, this.now())) return { signedIn: false };
    return {
      signedIn: true,
      via: stored.via,
      ...(stored.account ? { account: stored.account } : {}),
      signedInAt: stored.signedInAt,
    };
  }

  /** The last known access token, for agents reached without the bridge. */
  accessToken(serverUrl: string): string | undefined {
    const stored = this.cache.get(normalizeServerUrl(serverUrl));
    return stored && signInUsable(stored, this.now()) ? stored.accessToken : undefined;
  }

  /** Rereads one login, which a bridge may have refreshed since. */
  async reload(serverUrl: string): Promise<void> {
    const stored = await readSignIn(this.tokenFile(serverUrl));
    const key = normalizeServerUrl(serverUrl);
    if (stored) this.cache.set(key, stored);
    else this.cache.delete(key);
  }

  /**
   * Begins a sign-in. Most servers return a page to open in the browser; GitHub without an OAuth App
   * finishes at once from the GitHub CLI's login.
   */
  async start(serverUrl: string): Promise<SignInStart> {
    for (const [id, attempt] of this.attempts) {
      if (normalizeServerUrl(attempt.serverUrl) === normalizeServerUrl(serverUrl)) this.cancel(id);
    }
    const discovery = await discoverSignIn(serverUrl, this.fetch);
    if (isGitHubIssuer(discovery.authServer.issuer) && !discovery.authServer.registrationEndpoint) {
      return this.startGitHub(discovery);
    }
    return this.startBrowser(discovery);
  }

  /** Resolves once the sign-in started by `start` is saved; rejects with what went wrong. */
  async wait(attemptId: string): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new SignInError("That sign-in already ended. Start it again.");
    const result = await attempt.done;
    this.attempts.delete(attemptId);
    if (!result.ok) {
      if (result.error instanceof SignInError) throw result.error;
      throw new SignInError(
        `The sign-in did not finish. ${result.error instanceof Error ? result.error.message : ""}`.trim(),
      );
    }
  }

  cancel(attemptId: string): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return;
    attempt.controller.abort(new SignInError("Sign-in canceled."));
    void attempt.done.then(() => this.attempts.delete(attemptId));
  }

  async signOut(serverUrl: string): Promise<void> {
    this.cache.delete(normalizeServerUrl(serverUrl));
    await rm(this.tokenFile(serverUrl), { force: true });
  }

  /** Ends sign-ins still waiting on the browser. */
  close(): void {
    for (const id of this.attempts.keys()) this.cancel(id);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async save(serverUrl: string, stored: Omit<StoredSignIn, "version" | "serverUrl" | "signedInAt">) {
    const value: StoredSignIn = {
      version: 1,
      serverUrl,
      signedInAt: new Date(this.now()).toISOString(),
      ...stored,
    };
    await mkdir(this.options.dir, { recursive: true });
    await writeSignIn(this.tokenFile(serverUrl), value);
    this.cache.set(normalizeServerUrl(serverUrl), value);
  }

  private track(serverUrl: string, run: (signal: AbortSignal) => Promise<void>): string {
    const id = randomUUID();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new SignInError("The sign-in timed out. Start it again.")),
      ATTEMPT_TIMEOUT_MS,
    );
    timer.unref?.();
    const done = run(controller.signal).then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
    void done.finally(() => clearTimeout(timer));
    this.attempts.set(id, { serverUrl, controller, done });
    return id;
  }

  private async startBrowser(discovery: SignInDiscovery): Promise<SignInStart> {
    const service = hostOf(discovery.serverUrl);
    const loopback = await startLoopback({
      serviceName: service,
      ...(this.options.callbackPorts ? { ports: this.options.callbackPorts } : {}),
    });
    let client: OAuthClient;
    const clientKey = `${discovery.authServer.issuer}|${loopback.redirectUri}`;
    try {
      client =
        (await this.savedClient(clientKey)) ??
        (await registerClient(discovery.authServer, loopback.redirectUri, this.fetch));
      await this.saveClient(clientKey, client);
    } catch (error) {
      loopback.close();
      throw error;
    }
    const pkce = createPkce();
    const state = randomState();
    const url = authorizeUrl(discovery, client, { redirectUri: loopback.redirectUri, state, pkce });
    const attemptId = this.track(discovery.serverUrl, async (signal) => {
      try {
        const result = await loopback.waitForCallback(state, signal);
        if ("error" in result) throw new SignInError(`${service} did not finish the sign-in. ${result.error}`);
        const tokens = await tokenRequest(
          discovery.authServer.tokenEndpoint,
          {
            grant_type: "authorization_code",
            code: result.code,
            redirect_uri: loopback.redirectUri,
            code_verifier: pkce.verifier,
            resource: discovery.resource,
          },
          client,
          this.fetch,
          this.options.now,
        );
        await this.save(discovery.serverUrl, {
          via: "browser",
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
          ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
          ...(tokens.scope ? { scope: tokens.scope } : {}),
          refresh: {
            tokenEndpoint: discovery.authServer.tokenEndpoint,
            clientId: client.clientId,
            ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
            auth: client.auth,
            resource: discovery.resource,
          },
        });
      } catch (error) {
        // A saved registration the server has since forgotten would fail every retry the same way.
        await this.forgetClient(clientKey);
        throw error;
      } finally {
        loopback.close();
      }
    });
    return { status: "open", attemptId, url };
  }

  private async startGitHub(discovery: SignInDiscovery): Promise<SignInStart> {
    const clientId = this.options.githubClientId?.trim();
    if (clientId) {
      const code = await startDeviceFlow(clientId, discovery.scopes, this.fetch, this.options.now);
      const attemptId = this.track(discovery.serverUrl, async (signal) => {
        const tokens = await pollDeviceFlow(clientId, code, signal, {
          fetch: this.fetch,
          ...(this.options.now ? { now: this.options.now } : {}),
        });
        const account = await githubLogin(tokens.accessToken, this.fetch);
        await this.save(discovery.serverUrl, {
          via: "github-code",
          accessToken: tokens.accessToken,
          ...(tokens.scope ? { scope: tokens.scope } : {}),
          ...(account ? { account } : {}),
        });
      });
      return { status: "open", attemptId, url: code.verificationUri, code: code.userCode };
    }
    const token = await (this.options.githubCliToken ?? (() => githubCliToken(this.options.runner)))();
    if (!token) throw new SignInError(GITHUB_CLI_NEEDED);
    const account = await githubLogin(token, this.fetch);
    await this.save(discovery.serverUrl, { via: "github-cli", accessToken: token, ...(account ? { account } : {}) });
    return { status: "done" };
  }

  private async readClients(): Promise<Record<string, OAuthClient>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.options.dir, CLIENTS_FILE), "utf8"));
      return isPlainObject(parsed) ? (parsed as Record<string, OAuthClient>) : {};
    } catch {
      return {};
    }
  }

  private async savedClient(key: string): Promise<OAuthClient | undefined> {
    const client = (await this.readClients())[key];
    return isPlainObject(client) && typeof client.clientId === "string" ? client : undefined;
  }

  private async saveClient(key: string, client: OAuthClient): Promise<void> {
    const clients = await this.readClients();
    if (clients[key]?.clientId === client.clientId) return;
    clients[key] = client;
    await writeFileAtomic(join(this.options.dir, CLIENTS_FILE), `${JSON.stringify(clients, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  private async forgetClient(key: string): Promise<void> {
    const clients = await this.readClients();
    if (!(key in clients)) return;
    delete clients[key];
    await writeFileAtomic(join(this.options.dir, CLIENTS_FILE), `${JSON.stringify(clients, null, 2)}\n`, {
      mode: 0o600,
    }).catch(() => undefined);
  }
}
