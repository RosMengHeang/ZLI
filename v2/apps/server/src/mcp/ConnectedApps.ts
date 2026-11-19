import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  CONNECTED_APP_CATALOG,
  CONNECTED_APP_ID,
  type ConnectedAppsStatus,
  type McpServerConfig,
} from "@zli-v2/contracts";
import { z } from "zod";

import { writeFileAtomic } from "../browser-tool/browserTool.js";
import { SecretBox } from "../secrets/SecretBox.js";
import type { AppsUpstream } from "./AppsProxy.js";
import { McpRequestError } from "./McpServerStore.js";

/** Composio's API. One project key makes one Tool Router session, whose MCP server every agent gets. */
const API = "https://backend.composio.dev/api/v3.1";
/** The name the agents see the apps under: their tools are COMPOSIO_SEARCH_TOOLS and the rest. */
export const CONNECTED_APPS_SERVER = "composio";

/** Composio Connect's MCP server, which takes a ck_ consumer key. */
const CONNECT_MCP = "https://connect.composio.dev/mcp";

const ProjectSaved = z.object({
  via: z.literal("project").default("project"),
  apiKey: z.string().min(1),
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  mcpUrl: z.string().url(),
});
const ConnectSaved = z.object({ via: z.literal("connect"), apiKey: z.string().startsWith("ck_") });
const Saved = z.union([ConnectSaved, ProjectSaved]);
type Saved = z.infer<typeof Saved>;

const SessionReply = z.object({
  session_id: z.string().min(1),
  mcp: z.object({ url: z.string().min(1) }),
});

const AccountsReply = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      status: z.string().optional(),
      alias: z.string().nullish(),
      toolkit: z.object({ slug: z.string() }).partial().optional(),
    }),
  ),
});

const LinkReply = z.object({ redirect_url: z.string().optional() });

/** A JSON-RPC reply from an MCP tool call. */
const RpcReply = z.object({
  result: z
    .object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() })
    .optional(),
  error: z.object({ message: z.string() }).optional(),
});

/** What COMPOSIO_MANAGE_CONNECTIONS says, per app. */
const ManageReply = z.object({
  successful: z.boolean(),
  error: z.unknown().optional(),
  data: z
    .object({
      results: z.record(
        z.string(),
        z.object({
          redirect_url: z.string().optional(),
          accounts: z
            .array(z.object({ id: z.string(), status: z.string().optional(), alias: z.string().nullish() }))
            .optional(),
        }),
      ),
    })
    .nullish(),
});
type ManageResults = NonNullable<z.infer<typeof ManageReply>["data"]>["results"];

/** An MCP reply comes as plain JSON or as a server-sent event; this finds the JSON either way. */
function rpcBody(text: string): unknown {
  const events = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  for (const candidate of [...events.reverse(), text]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Not this one.
    }
  }
  return undefined;
}

type Fetch = typeof fetch;

/**
 * Apps connected through Composio: Gmail, Slack, GitHub, Notion, Linear and hundreds more. The person saves a
 * Composio project key once and signs in to each app once in their browser; every agent ZLI starts then gets
 * Composio's MCP server, which finds and runs those apps' tools.
 *
 * The key and the session are kept in one owner-only file beside the database. The key is only ever sent to
 * Composio.
 */
export class ConnectedApps {
  private saved: Saved | undefined;
  /** A key was saved but cannot be opened here (sealed on another computer or with another keychain). */
  private unreadable = false;

  constructor(
    private readonly options: {
      path: string;
      fetch?: Fetch;
      /** Called after the key changes, so agents started from then on get the server, or lose it. */
      onChange?: () => void;
      /** The local stand-in agents reach instead of Composio, so they never hold the key. */
      proxy?: { endpoint(worktreeId?: string): { url: string; headers: Record<string, string> } | undefined };
      /** Seals the key on disk with the OS keychain's key. Without it the file holds the key as before. */
      box?: SecretBox;
    },
  ) {}

  async load(): Promise<void> {
    this.unreadable = false;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.options.path, "utf8"));
    } catch {
      this.saved = undefined;
      return;
    }
    const stored = (raw as { apiKey?: unknown } | null)?.apiKey;
    if (typeof stored !== "string") {
      this.saved = undefined;
      return;
    }
    const box = this.options.box;
    const sealed = SecretBox.isSealed(stored);
    const apiKey = sealed ? box?.open(stored) : stored;
    if (apiKey === undefined) {
      this.saved = undefined;
      this.unreadable = true;
      return;
    }
    const parsed = Saved.safeParse({ ...(raw as object), apiKey });
    this.saved = parsed.success ? parsed.data : undefined;
    // A key saved before keys were sealed is sealed now, so the file stops holding it in the clear.
    if (this.saved && !sealed && box) await this.write().catch(() => undefined);
  }

  /** Writes the saved key, sealed when a box is set, readable only by this account. */
  private async write(): Promise<void> {
    const saved = this.saved;
    if (!saved) return;
    const box = this.options.box;
    const stored = { ...saved, apiKey: box ? box.seal(saved.apiKey) : saved.apiKey };
    await writeFileAtomic(this.options.path, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  }

  /**
   * The MCP server agents get, once a key is saved. With the local proxy running, that is the proxy's address
   * and its token, so the key itself never reaches an agent, its settings or its files.
   */
  server(worktreeId?: string): McpServerConfig | undefined {
    const upstream = this.upstream();
    if (!upstream) return undefined;
    const local = this.options.proxy?.endpoint(worktreeId);
    const reach = local ?? upstream;
    return {
      name: CONNECTED_APPS_SERVER,
      enabled: true,
      transport: "http",
      url: reach.url,
      headers: { ...reach.headers },
      oauth: false,
    };
  }

  /** Composio's real address and key: only the proxy, inside ZLI, uses it. */
  upstream(): AppsUpstream | undefined {
    const saved = this.saved;
    if (!saved) return undefined;
    if (saved.via === "connect") return { url: CONNECT_MCP, headers: { "x-consumer-api-key": saved.apiKey } };
    return { url: saved.mcpUrl, headers: { "x-api-key": saved.apiKey } };
  }

  /** Saves a project key after checking it with Composio, or clears it with "". */
  async setKey(key: string): Promise<ConnectedAppsStatus> {
    const apiKey = key.trim();
    if (!apiKey) {
      this.saved = undefined;
      this.unreadable = false;
      await writeFileAtomic(this.options.path, "{}\n");
      this.options.onChange?.();
      return this.status();
    }
    if (apiKey.startsWith("ck_")) {
      await this.checkConnectKey(apiKey);
      this.saved = { via: "connect", apiKey };
    } else if (apiKey.startsWith("ak_")) {
      // A key already in use keeps its user, so apps connected before stay connected.
      const before = this.saved?.via === "project" && this.saved.apiKey === apiKey ? this.saved : undefined;
      const userId = before?.userId ?? `zli_${randomUUID()}`;
      const session = await this.createSession(apiKey, userId);
      this.saved = { via: "project", apiKey, userId, sessionId: session.session_id, mcpUrl: session.mcp.url };
    } else
      throw new ConnectedAppsError(
        "That is not a Composio key. Paste the one that starts with ck_ (Connect → Settings) or ak_ (project API Keys).",
      );
    this.unreadable = false;
    await this.write();
    this.options.onChange?.();
    return this.status();
  }

  /** Whether a key is saved, and the accounts connected under it. */
  async status(): Promise<ConnectedAppsStatus> {
    const saved = this.saved;
    if (!saved)
      return this.unreadable
        ? {
            configured: false,
            accounts: [],
            problem: "The saved Composio key can't be opened on this computer. Paste it again to keep using your apps.",
          }
        : { configured: false, accounts: [] };
    if (saved.via === "connect") {
      // Composio Connect lists accounts per app, so it is asked about every app the window offers at once.
      try {
        const results = await this.manage(
          saved.apiKey,
          CONNECTED_APP_CATALOG.map((entry) => ({ name: entry.app, action: "list" })),
        );
        const accounts = Object.entries(results).flatMap(([app, result]) =>
          (result.accounts ?? []).map((account) => ({
            // Removing one needs its app too, so the id carries it.
            accountId: `${app}:${account.id}`,
            app,
            status: (account.status ?? "active").toLowerCase(),
            ...(account.alias ? { label: account.alias } : {}),
          })),
        );
        return { configured: true, via: "connect", accounts };
      } catch (error) {
        return { configured: true, via: "connect", accounts: [], problem: messageOf(error) };
      }
    }
    try {
      const params = new URLSearchParams({ user_ids: saved.userId, limit: "100" });
      const reply = await this.call(saved.apiKey, `/connected_accounts?${params}`);
      const accounts = AccountsReply.parse(reply).items.map((item) => ({
        accountId: item.id,
        app: item.toolkit?.slug ?? "app",
        status: (item.status ?? "ACTIVE").toLowerCase(),
        ...(item.alias ? { label: item.alias } : {}),
      }));
      return { configured: true, via: "project", accounts };
    } catch (error) {
      return { configured: true, via: "project", accounts: [], problem: messageOf(error) };
    }
  }

  /** A link where the person signs in to an app; once they finish, every agent can use it. */
  async connect(app: string): Promise<{ url: string }> {
    const saved = this.require();
    const toolkit = app.trim().toLowerCase();
    if (!CONNECTED_APP_ID.test(toolkit))
      throw new ConnectedAppsError("Name the app by its Composio id, such as gmail.");
    if (saved.via === "connect") {
      const url = (await this.manage(saved.apiKey, [{ name: toolkit, action: "add" }]))[toolkit]?.redirect_url;
      if (!url || !isComposioPage(url)) throw new ConnectedAppsError(`Composio sent no sign-in link for ${toolkit}.`);
      return { url };
    }
    const reply = LinkReply.parse(
      await this.call(saved.apiKey, `/tool_router/session/${encodeURIComponent(saved.sessionId)}/link`, {
        method: "POST",
        body: JSON.stringify({ toolkit }),
      }),
    );
    const url = reply.redirect_url;
    if (!url || !isComposioPage(url)) throw new ConnectedAppsError(`Composio sent no sign-in link for ${toolkit}.`);
    return { url };
  }

  /** Disconnects one account and revokes its sign-in. */
  async disconnect(accountId: string): Promise<ConnectedAppsStatus> {
    const saved = this.require();
    const owned = (await this.status()).accounts.find((account) => account.accountId === accountId);
    if (!owned) throw new ConnectedAppsError("That account is not connected here.");
    if (saved.via === "connect") {
      const id = accountId.slice(owned.app.length + 1);
      await this.manage(saved.apiKey, [{ name: owned.app, action: "remove", account_id: id }]);
      return this.status();
    }
    await this.call(saved.apiKey, `/connected_accounts/${encodeURIComponent(accountId)}?revoke_on_delete=true`, {
      method: "DELETE",
    });
    return this.status();
  }

  private require(): Saved {
    if (!this.saved) throw new ConnectedAppsError("Add your Composio key first.");
    return this.saved;
  }

  /**
   * One call to Composio Connect's COMPOSIO_MANAGE_CONNECTIONS tool, the same one agents use: list, add (a
   * sign-in link) or remove, per app. Replies with what it said about each app.
   */
  private async manage(apiKey: string, toolkits: readonly Record<string, string>[]): Promise<ManageResults> {
    const fetcher = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetcher(CONNECT_MCP, {
        method: "POST",
        headers: {
          "x-consumer-api-key": apiKey,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits } },
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ConnectedAppsError("Composio could not be reached. Check the connection and try again.");
    }
    if (response.status === 401 || response.status === 403)
      throw new ConnectedAppsError("Composio did not accept this key.");
    const text = await response.text();
    if (!response.ok)
      throw new ConnectedAppsError(scrub(`Composio said: ${problemIn(text) ?? `HTTP ${response.status}`}`, apiKey));
    const rpc = RpcReply.safeParse(rpcBody(text));
    const said = rpc.success ? rpc.data.result?.content?.find((part) => part.type === "text")?.text : undefined;
    if (!rpc.success || rpc.data.error || !said)
      throw new ConnectedAppsError(
        scrub(`Composio said: ${rpc.data?.error?.message ?? "no answer"}`.slice(0, 300), apiKey),
      );
    let parsed: z.infer<typeof ManageReply>;
    try {
      parsed = ManageReply.parse(JSON.parse(said));
    } catch {
      throw new ConnectedAppsError(scrub(`Composio said: ${said.slice(0, 300)}`, apiKey));
    }
    if (!parsed.successful || !parsed.data)
      throw new ConnectedAppsError(
        scrub(`Composio said: ${String(parsed.error ?? "it could not do that")}`.slice(0, 300), apiKey),
      );
    return parsed.data.results;
  }

  /** One MCP hello to Composio Connect: it answers 401 for a key it does not know. */
  private async checkConnectKey(apiKey: string): Promise<void> {
    const fetcher = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetcher(CONNECT_MCP, {
        method: "POST",
        headers: {
          "x-consumer-api-key": apiKey,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "zli", version: "1" } },
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ConnectedAppsError("Composio could not be reached. Check the connection and try again.");
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403)
      throw new ConnectedAppsError("Composio did not accept this key.");
    if (!response.ok) throw new ConnectedAppsError(`Composio said: HTTP ${response.status}`);
  }

  private async createSession(apiKey: string, userId: string) {
    const reply = await this.call(apiKey, "/tool_router/session", {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        manage_connections: { enable: true, enable_wait_for_connections: true, enable_connection_removal: true },
      }),
    });
    const session = SessionReply.parse(reply);
    const url = new URL(session.mcp.url);
    // The key goes with every call to this address, so it must be Composio's own.
    if (url.protocol !== "https:" || !(url.hostname === "composio.dev" || url.hostname.endsWith(".composio.dev")))
      throw new ConnectedAppsError("Composio sent an address that is not its own.");
    return session;
  }

  private async call(apiKey: string, path: string, init: RequestInit = {}): Promise<unknown> {
    const fetcher = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetcher(`${API}${path}`, {
        ...init,
        headers: { "x-api-key": apiKey, ...(init.body ? { "content-type": "application/json" } : {}) },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ConnectedAppsError("Composio could not be reached. Check the connection and try again.");
    }
    const text = await response.text();
    if (response.status === 401 || response.status === 403)
      throw new ConnectedAppsError("Composio did not accept this key.");
    if (!response.ok)
      throw new ConnectedAppsError(scrub(`Composio said: ${problemIn(text) ?? `HTTP ${response.status}`}`, apiKey));
    return text ? JSON.parse(text) : {};
  }
}

/** A problem the person can act on; its message is shown as it is. */
export class ConnectedAppsError extends McpRequestError {}

function problemIn(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: { message?: unknown } | string };
    const said = body.message ?? (typeof body.error === "string" ? body.error : body.error?.message);
    return typeof said === "string" ? said.slice(0, 300) : undefined;
  } catch {
    return text.trim().slice(0, 300) || undefined;
  }
}

/** A sign-in page ZLI may open: https, on Composio's own domain, so a bad answer cannot send the person elsewhere. */
export function isComposioPage(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && (url.hostname === "composio.dev" || url.hostname.endsWith(".composio.dev"));
  } catch {
    return false;
  }
}

/** Never shows the key, even if Composio repeats it back in an error. */
function scrub(message: string, apiKey: string): string {
  return apiKey.length >= 8 ? message.split(apiKey).join("[key]") : message;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
