import type { CSSProperties } from "react";

import { providerDisplayName } from "../agent/providers.js";
import type { AgentSession } from "../sessions/sessions.js";
import { ProviderMark } from "../ui/ProviderMark.js";

/** Most logos a row shows; the rest become "+n". */
const MAX_SHOWN = 3;

/**
 * Every agent a chat has had, newest first: the one it runs on now, the ones it switched away from, then the
 * teammates brought into it. Each agent once.
 */
export function chatAgents(session: AgentSession, teammates: readonly AgentSession[] = []): string[] {
  const byLatest = [...(session.threads ?? [])].sort((left, right) =>
    (right.updatedAt ?? right.createdAt ?? "").localeCompare(left.updatedAt ?? left.createdAt ?? ""),
  );
  const providers = [
    session.provider,
    ...byLatest.map((thread) => thread.provider),
    ...teammates.map((t) => t.provider),
  ];
  return [...new Set(providers)];
}

/** The chat's agents as logos that overlap, the newest in front, like faces in a group chat. */
export function AgentStack({ providers, size = 12 }: { providers: readonly string[]; size?: number }) {
  if (providers.length <= 1) return <ProviderMark provider={providers[0] ?? "unknown"} size={size} />;
  const shown = providers.slice(0, MAX_SHOWN);
  const more = providers.length - shown.length;
  return (
    <span
      className="agent-stack"
      style={{ "--agent-size": `${size + 4}px` } as CSSProperties}
      title={providers.map((provider) => providerDisplayName(provider, undefined)).join(", ")}
    >
      {shown.map((provider, index) => (
        <span className="agent-stack-item" key={provider} style={{ zIndex: MAX_SHOWN - index }}>
          <ProviderMark provider={provider} size={size} />
        </span>
      ))}
      {more > 0 ? <span className="agent-stack-more">+{more}</span> : null}
    </span>
  );
}
