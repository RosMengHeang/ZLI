import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ConnectedAppsStatus, McpServerConfig } from "@zli-v2/contracts";
import { z } from "zod";

import { writeFileAtomic } from "../browser-tool/browserTool.js";
import { McpRequestError } from "./McpServerStore.js";

/** Composio's API. One project key makes one Tool Router session, whose MCP server every agent gets. */
const API = "https://backend.composio.dev/api/v3.1";
/** The name the agents see the apps under: their tools are COMPOSIO_SEARCH_TOOLS and the rest. */
export const CONNECTED_APPS_SERVER = "composio";

const Saved = z.object({
  apiKey: z.string().min(1),
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  mcpUrl: z.string().url(),
});
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

  constructor(
    private readonly options: {
      path: string;
      fetch?: Fetch;
      /** Called after the key changes, so agents started from then on get the server, or lose it. */
      onChange?: () => void;
    },
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = Saved.safeParse(JSON.parse(await readFile(this.options.path, "utf8")));
      this.saved = parsed.success ? parsed.data : undefined;
    } catch {
      this.saved = undefined;
    }
  }

  /** The MCP server agents get, once a key is saved. */
  server(): McpServerConfig | undefined {
    const saved = this.saved;
    if (!saved) return undefined;
    return {
      name: CONNECTED_APPS_SERVER,
      enabled: true,
      transport: "http",
      url: saved.mcpUrl,
      headers: { "x-api-key": saved.apiKey },
      oauth: false,
    };
  }

  /** Saves a project key after checking it with Composio, or clears it with "". */
  async setKey(key: string): Promise<ConnectedAppsStatus> {
    const apiKey = key.trim();
    if (!apiKey) {
      this.saved = undefined;
      await writeFileAtomic(this.options.path, "{}\n");
      this.options.onChange?.();
      return this.status();
    }
    if (!apiKey.startsWith("ak_"))
      throw new ConnectedAppsError(
        "That is not a project key. Copy the one that starts with ak_ from your Composio project's API Keys page.",
      );
    // A key already in use keeps its user, so apps connected before stay connected.
    const userId = this.saved?.apiKey === apiKey ? this.saved.userId : `zli_${randomUUID()}`;
    const session = await this.createSession(apiKey, userId);
    this.saved = { apiKey, userId, sessionId: session.session_id, mcpUrl: session.mcp.url };
    await writeFileAtomic(this.options.path, `${JSON.stringify(this.saved, null, 2)}\n`, { mode: 0o600 });
    this.options.onChange?.();
    return this.status();
  }

  /** Whether a key is saved, and the accounts connected under it. */
  async status(): Promise<ConnectedAppsStatus> {
    const saved = this.saved;
    if (!saved) return { configured: false, accounts: [] };
    try {
      const params = new URLSearchParams({ user_ids: saved.userId, limit: "100" });
      const reply = await this.call(saved.apiKey, `/connected_accounts?${params}`);
      const accounts = AccountsReply.parse(reply).items.map((item) => ({
        accountId: item.id,
        app: item.toolkit?.slug ?? "app",
        status: (item.status ?? "ACTIVE").toLowerCase(),
        ...(item.alias ? { label: item.alias } : {}),
      }));
      return { configured: true, accounts };
    } catch (error) {
      return { configured: true, accounts: [], problem: messageOf(error) };
    }
  }

  /** A link where the person signs in to an app; once they finish, every agent can use it. */
  async connect(app: string): Promise<{ url: string }> {
    const saved = this.require();
    const toolkit = app.trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,60}$/u.test(toolkit))
      throw new ConnectedAppsError("Name the app by its Composio id, such as gmail.");
    const reply = LinkReply.parse(
      await this.call(saved.apiKey, `/tool_router/session/${encodeURIComponent(saved.sessionId)}/link`, {
        method: "POST",
        body: JSON.stringify({ toolkit }),
      }),
    );
    const url = reply.redirect_url;
    if (!url || !/^https:\/\//u.test(url))
      throw new ConnectedAppsError(`Composio sent no sign-in link for ${toolkit}.`);
    return { url };
  }

  /** Disconnects one account and revokes its sign-in. */
  async disconnect(accountId: string): Promise<ConnectedAppsStatus> {
    const saved = this.require();
    const owned = (await this.status()).accounts.some((account) => account.accountId === accountId);
    if (!owned) throw new ConnectedAppsError("That account is not connected here.");
    await this.call(saved.apiKey, `/connected_accounts/${encodeURIComponent(accountId)}?revoke_on_delete=true`, {
      method: "DELETE",
    });
    return this.status();
  }

  private require(): Saved {
    if (!this.saved) throw new ConnectedAppsError("Add your Composio project key first.");
    return this.saved;
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
    if (!response.ok) throw new ConnectedAppsError(`Composio said: ${problemIn(text) ?? `HTTP ${response.status}`}`);
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
