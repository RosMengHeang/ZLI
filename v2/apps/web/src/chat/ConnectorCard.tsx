import {
  catalogEntryServer,
  catalogMissingField,
  catalogServer,
  catalogSignsIn,
  isHttpServer,
  MCP_CATALOG,
  type McpCatalogEntry,
  type McpListResult,
  type McpServerConfig,
  type ThreadActivityConnector,
} from "@zli-v2/contracts";
import { useState } from "react";

import { ConnectorLogo } from "../settings/connectorLogos.js";
import { applyServer, isWindows, SIGN_IN_CANCELED, signInFor, useMcpServers } from "../settings/mcpServers.js";
import { Button } from "../ui/Button.js";
import "../settings/connectors.css";

export type ConnectorTarget = {
  entry: McpCatalogEntry | undefined;
  server: McpServerConfig | undefined;
  /** The catalog id, or the server name when it is not from the catalog. */
  id: string;
  title: string;
};

/** What the person still has to do before an agent can use the connector. */
export type ConnectorNeed = "sign-in" | "add" | "turn-on" | "settings" | "none";

/** The catalog entry and saved server a connector names, matched by server name, catalog id, or title. */
export function connectorTarget(name: string, result: McpListResult): ConnectorTarget {
  const key = name.toLowerCase();
  const named = result.servers.find((server) => server.name.toLowerCase() === key);
  const entry =
    MCP_CATALOG.find((candidate) => candidate.id === key || candidate.title.toLowerCase() === key) ??
    (named ? MCP_CATALOG.find((candidate) => catalogEntryServer(candidate, [named])) : undefined);
  const server = named ?? (entry ? catalogEntryServer(entry, result.servers) : undefined);
  return { entry, server, id: entry?.id ?? server?.name ?? name, title: entry?.title ?? server?.name ?? name };
}

export function connectorNeed(target: ConnectorTarget, result: McpListResult): ConnectorNeed {
  const { server, entry } = target;
  if (server) {
    if (!server.enabled) return "turn-on";
    if (isHttpServer(server) && server.oauth && !signInFor(result, server.name)?.signedIn) return "sign-in";
    return "none";
  }
  if (entry && !catalogMissingField(entry, {})) return "add";
  return "settings";
}

type Phase = { kind: "idle"; problem?: string } | { kind: "working" } | { kind: "done" };

/**
 * Offers to connect or sign in to a connector a tool call needs, right in the chat. Signing in works
 * for the running agent; a newly added connector reaches only new chats.
 */
export function ConnectorCard({
  connector,
  displayName,
  onTryAgain,
  onNewChat,
  onOpenConnectors,
  onDismiss,
}: {
  connector: ThreadActivityConnector;
  displayName: string;
  /** Sends a message asking the agent to try again. Absent when the chat has ended. */
  onTryAgain?: ((text: string) => Promise<boolean>) | undefined;
  onNewChat(): void;
  onOpenConnectors?: ((connectorId?: string) => void) | undefined;
  onDismiss(): void;
}) {
  const { state, save, signIn, cancelSignIn, pending } = useMcpServers();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [added, setAdded] = useState(false);
  if (state.status !== "ready") return null;
  const result = state.result;
  const target = connectorTarget(connector.server, result);
  const need = connectorNeed(target, result);
  if (phase.kind === "idle" && need === "none") return null;
  const { entry, server, title } = target;
  const signInName = server?.name ?? entry?.id;
  const waiting = phase.kind === "working" && signInName ? pending[signInName] : undefined;

  const connect = async () => {
    if (need === "settings") {
      onOpenConnectors?.(target.id);
      return;
    }
    setPhase({ kind: "working" });
    try {
      if (need === "add" && entry) {
        const next = catalogServer(entry, {}, { windows: isWindows() });
        const applied = applyServer(result.servers, next, undefined);
        if ("problem" in applied) throw new Error(applied.problem);
        await save(applied.servers);
        setAdded(true);
        if (catalogSignsIn(entry)) await signIn(next.name);
      } else if (need === "turn-on" && server) {
        const saved = await save(
          result.servers.map((candidate) =>
            candidate.name === server.name ? { ...candidate, enabled: true } : candidate,
          ),
        );
        setAdded(true);
        if (isHttpServer(server) && server.oauth && !signInFor(saved, server.name)?.signedIn) await signIn(server.name);
      } else if (server) {
        await signIn(server.name);
      }
      setPhase({ kind: "done" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPhase(message === SIGN_IN_CANCELED ? { kind: "idle" } : { kind: "idle", problem: message });
    }
  };

  if (phase.kind === "done") {
    return (
      <section className="chat-connector" aria-label={`Connect ${title}`} data-connector={target.id} role="status">
        <ConnectorLogo id={target.id} title={title} size={28} />
        <span className="chat-connector-copy">
          <span className="chat-connector-title">{added ? `${title} is connected` : `Signed in to ${title}`}</span>
          <span className="chat-connector-detail">
            {added ? "Start a new chat so the agent can use it." : "Ask the agent to try again."}
          </span>
        </span>
        <span className="chat-connector-actions">
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Close
          </Button>
          {added ? (
            <Button size="sm" variant="primary" icon="plus" onClick={onNewChat}>
              New chat
            </Button>
          ) : onTryAgain ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() =>
                void onTryAgain(`I signed in to ${title}. Please try again.`).then((sent) => {
                  if (sent) onDismiss();
                })
              }
            >
              Try again
            </Button>
          ) : null}
        </span>
      </section>
    );
  }

  const asked = connector.reason === "request";
  const heading =
    need === "sign-in"
      ? asked
        ? `${displayName} asks you to sign in to ${title}`
        : `${title} needs you to sign in`
      : `${displayName} asks to connect ${title}`;
  const detail =
    phase.kind === "idle" && phase.problem
      ? phase.problem
      : need === "sign-in"
        ? "Sign in so the agent can use it."
        : need === "settings"
          ? entry
            ? "It needs a few details first. Add them in Settings."
            : "Add it in Settings, under MCP servers."
          : (entry?.description ?? "Turn it on so new chats can use it.");
  const action = need === "sign-in" ? "Sign in" : need === "settings" ? "Open Settings" : "Connect";

  return (
    <section className="chat-connector" aria-label={`Connect ${title}`} data-connector={target.id}>
      <ConnectorLogo id={target.id} title={title} size={28} />
      <span className="chat-connector-copy">
        <span className="chat-connector-title">{heading}</span>
        {waiting ? (
          <span className="chat-connector-detail chat-connector-waiting" role="status">
            <span className="spinner" aria-hidden="true" />
            Finish in your browser
            {waiting.code ? ` with code ${waiting.code}` : ""}
          </span>
        ) : (
          <span
            className={`chat-connector-detail${phase.kind === "idle" && phase.problem ? " is-problem" : ""}`}
            {...(phase.kind === "idle" && phase.problem ? { role: "alert" } : {})}
          >
            {detail}
          </span>
        )}
      </span>
      <span className="chat-connector-actions">
        {waiting && signInName ? (
          <Button size="sm" variant="ghost" onClick={() => cancelSignIn(signInName)}>
            Cancel
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" disabled={phase.kind === "working"} onClick={onDismiss}>
              Not now
            </Button>
            {need !== "settings" || onOpenConnectors ? (
              <Button size="sm" variant="primary" loading={phase.kind === "working"} onClick={() => void connect()}>
                {action}
              </Button>
            ) : null}
          </>
        )}
      </span>
    </section>
  );
}
